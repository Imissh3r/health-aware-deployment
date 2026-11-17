import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = new URL('../../', import.meta.url);
const configPath = fileURLToPath(new URL('infra/nginx/conf.d/default.conf', repoRoot));
const proxyUrl = 'http://127.0.0.1:8080/api/work';
const stableVersion = '1.0.0';
const candidateVersion = '2.0.0';

function verificationSettings() {
  const { values } = parseArgs({
    options: {
      'verification-window-ms': { type: 'string', default: '5000' },
      'verification-interval-ms': { type: 'string', default: '200' }
    }
  });
  return Object.fromEntries(Object.entries(values).map(([name, raw]) => {
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < 1 || value > 2_147_483_647) {
      throw new Error(`--${name} must be a positive integer in the Node timer range`);
    }
    return [name.replaceAll('-', '_'), value];
  }));
}

function run(command, args, timeout) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', timeout });
  if (result.error) throw result.error;
  return result;
}

function nginx(...args) {
  const result = run('docker', ['compose', '--profile', 'routing', 'exec',
    '-T', 'nginx', 'nginx', ...args], 10_000);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `nginx exited with status ${result.status}`);
  }
}

function validateCandidate() {
  const result = run(process.execPath, [fileURLToPath(new URL('./validate.mjs', import.meta.url))],
    20_000);
  const event = JSON.parse(result.stdout);
  const expectedExit = { ELIGIBLE_FOR_PROMOTION: 0, REJECTED: 2, INCONCLUSIVE: 3, FAILED: 1 };
  if (!Object.hasOwn(expectedExit, event.status) || result.status !== expectedExit[event.status]) {
    throw new Error('Validation returned an inconsistent decision');
  }
  return [event, result.status];
}

function candidateConfig(original) {
  const text = original.toString('utf8');
  const directive = /^[\t ]*proxy_pass[\t ]+([^;\r\n]+);/gm;
  const routes = [...text.matchAll(directive)];
  if (routes.length !== 1 || routes[0][1] !== 'http://app:3000') {
    throw new Error('Expected one saved proxy_pass to app:3000');
  }
  return text.replace(directive, match => match.replace('http://app:3000', 'http://candidate:3000'));
}

function replaceConfig(contents, mode) {
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode });
    renameSync(temporary, configPath);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write or rename error.
    }
    throw error;
  }
}

async function observeProxy(timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let status = null;
  try {
    const response = await fetch(proxyUrl, {
      signal, redirect: 'manual', headers: { Connection: 'close' }
    });
    status = response.status;
    if (status === 200) {
      const body = await response.json();
      return { http_status: status, version: body?.version ?? null };
    }
    await response.body?.cancel();
    return { http_status: status, version: null };
  } catch (error) {
    return { http_status: status, version: null, error: error.message };
  }
}

async function verifyProxy(version, settings) {
  const start = performance.now();
  const deadline = start + settings.verification_window_ms;
  let attempts = 0;
  let consecutive = 0;
  let last = null;

  while (true) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) break;
    attempts++;
    last = await observeProxy(Math.min(remaining, 1000));
    consecutive = last.http_status === 200 && last.version === version ? consecutive + 1 : 0;
    const timeLeft = deadline - performance.now();
    if (consecutive === 3 || timeLeft < 1) break;
    await sleep(Math.min(settings.verification_interval_ms, timeLeft));
  }

  const elapsedMs = performance.now() - start;
  return {
    passed: consecutive === 3 && elapsedMs <= settings.verification_window_ms,
    expected_version: version,
    attempts,
    consecutive,
    elapsed_ms: elapsedMs,
    last_observation: last
  };
}

async function restore(original, mode, reloadAttempted, settings) {
  const result = { status: 'RECOVERY_FAILED', file_restored: false };
  let step = 'restore_config';
  try {
    replaceConfig(original, mode);
    result.file_restored = true;
    if (reloadAttempted) {
      step = 'test_restored_config';
      nginx('-t');
      step = 'reload_restored_config';
      nginx('-s', 'reload');
    }
  } catch (error) {
    result.operation_error = { step, reason: error.message };
  }

  result.verification = await verifyProxy(stableVersion, settings);
  if (result.file_restored && !result.operation_error && result.verification.passed) {
    result.status = 'RESTORED';
  }
  return result;
}

async function promote(event) {
  let stage = 'arguments';
  let settings;
  let original;
  let mode;
  let configChanged = false;
  let reloadAttempted = false;

  try {
    settings = verificationSettings();
    event.settings = settings;

    stage = 'check_saved_config';
    original = readFileSync(configPath);
    mode = statSync(configPath).mode & 0o777;
    const nextConfig = candidateConfig(original);

    stage = 'verify_stable_route';
    event.preflight = await verifyProxy(stableVersion, settings);
    if (!event.preflight.passed) throw new Error('Could not verify the stable route');

    stage = 'validate_candidate';
    const [validation, exitCode] = validateCandidate();
    event.validation = validation;
    if (validation.status === 'FAILED') throw new Error(validation.reason);
    if (validation.status !== 'ELIGIBLE_FOR_PROMOTION') {
      event.status = 'PROMOTION_BLOCKED';
      event.reason = validation.reason;
      return exitCode;
    }

    stage = 'write_candidate_config';
    if (!readFileSync(configPath).equals(original)) {
      throw new Error('Saved Nginx configuration changed during validation');
    }
    replaceConfig(nextConfig, mode);
    configChanged = true;

    stage = 'test_candidate_config';
    nginx('-t');

    stage = 'reload_candidate_config';
    reloadAttempted = true;
    nginx('-s', 'reload');

    stage = 'verify_candidate_route';
    event.verification = await verifyProxy(candidateVersion, settings);
    if (!event.verification.passed) throw new Error('Could not verify the candidate route');

    event.status = 'PROMOTED';
    return 0;
  } catch (error) {
    event.status = 'PROMOTION_FAILED';
    event.failed_stage = stage;
    event.reason = error.message;
    if (configChanged) event.recovery = await restore(original, mode, reloadAttempted, settings);
    return 1;
  }
}

const event = { event: 'candidate_promotion', started_at: new Date().toISOString() };
process.exitCode = await promote(event);
event.completed_at = new Date().toISOString();
console.log(JSON.stringify(event, null, 2));
