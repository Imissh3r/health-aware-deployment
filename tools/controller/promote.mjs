import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  prepareDeployment, readDeployment, readRoutingState, withRoutingLock, writeAtomic,
  writeDeployment, writeRoutingState
} from './deployment-state.mjs';

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
    writeAtomic(configPath, original, mode);
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

async function reconcilePending(id, settings, event) {
  const { manifest, previous, candidate } = readDeployment(id);
  const reconciliation = { deployment_id: id, status: 'RECONCILIATION_FAILED' };
  event.reconciliation = reconciliation;
  const possibleStates = ['PREPARED', 'PROMOTION_IN_PROGRESS', 'PROMOTED',
    'PROMOTION_FAILED', 'PROMOTION_INTERRUPTED'];
  if (manifest.previous_version !== stableVersion || manifest.candidate_version !== candidateVersion ||
      !possibleStates.includes(manifest.status)) {
    reconciliation.status = 'CONFLICT';
    throw new Error('Pending deployment manifest conflicts with the promotion workflow');
  }
  const current = readFileSync(configPath);
  if (!current.equals(previous) && !current.equals(candidate)) {
    reconciliation.status = 'CONFLICT';
    throw new Error('Saved route conflicts with the pending deployment snapshots');
  }

  reconciliation.recovery = await restore(previous, manifest.config_mode, true, settings);
  if (reconciliation.recovery.status !== 'RESTORED') {
    reconciliation.status = 'RECOVERY_FAILED';
    throw new Error('Could not reconcile the interrupted promotion');
  }
  writeDeployment(manifest, { status: 'PROMOTION_INTERRUPTED', recovery: reconciliation.recovery });
  writeRoutingState(null, null);
  reconciliation.status = 'RECONCILED';
}

async function promote(event, settings) {
  let stage = 'reconcile_pending_deployment';
  let original;
  let mode;
  let activationPending = false;
  let deployment;
  let configChanged = false;
  let reloadAttempted = false;

  try {
    const state = readRoutingState();
    if (state.pending_deployment_id) {
      await reconcilePending(state.pending_deployment_id, settings, event);
    }

    stage = 'check_saved_config';
    original = readFileSync(configPath);
    mode = statSync(configPath).mode & 0o777;
    const nextConfig = Buffer.from(candidateConfig(original));

    stage = 'verify_stable_route';
    event.preflight = await verifyProxy(stableVersion, settings);
    if (!event.preflight.passed) throw new Error('Could not verify the stable route');

    stage = 'save_deployment_snapshot';
    deployment = prepareDeployment(original, nextConfig, mode, stableVersion, candidateVersion);
    event.deployment_id = deployment.deployment_id;

    stage = 'validate_candidate';
    const [validation, exitCode] = validateCandidate();
    event.validation = validation;
    if (validation.status === 'FAILED') throw new Error(validation.reason);
    if (validation.status !== 'ELIGIBLE_FOR_PROMOTION') {
      writeDeployment(deployment, { status: 'PROMOTION_BLOCKED', reason: validation.reason });
      event.status = 'PROMOTION_BLOCKED';
      event.reason = validation.reason;
      return exitCode;
    }

    stage = 'publish_pending_deployment';
    writeRoutingState(null, deployment.deployment_id);
    activationPending = true;
    stage = 'mark_promotion_in_progress';
    deployment = writeDeployment(deployment, { status: 'PROMOTION_IN_PROGRESS' });

    stage = 'write_candidate_config';
    if (!readFileSync(configPath).equals(original)) {
      throw new Error('Saved Nginx configuration changed during validation');
    }
    writeAtomic(configPath, nextConfig, mode);
    configChanged = true;

    stage = 'test_candidate_config';
    nginx('-t');

    stage = 'reload_candidate_config';
    reloadAttempted = true;
    nginx('-s', 'reload');

    stage = 'verify_candidate_route';
    event.verification = await verifyProxy(candidateVersion, settings);
    if (!event.verification.passed) throw new Error('Could not verify the candidate route');

    stage = 'save_promoted_manifest';
    deployment = writeDeployment(deployment, {
      status: 'PROMOTED', verified_at: new Date().toISOString()
    });
    stage = 'publish_active_deployment';
    writeRoutingState(deployment.deployment_id, null);

    event.status = 'PROMOTED';
    return 0;
  } catch (error) {
    event.status = 'PROMOTION_FAILED';
    event.failed_stage = stage;
    event.reason = error.message;
    if (configChanged) event.recovery = await restore(original, mode, reloadAttempted, settings);

    try {
      if (deployment) writeDeployment(deployment, {
        status: 'PROMOTION_FAILED', failed_stage: stage, reason: error.message, recovery: event.recovery
      });
      if (activationPending && (!configChanged || event.recovery?.status === 'RESTORED')) {
        writeRoutingState(null, null);
      }
    } catch (stateError) {
      event.handoff_error = stateError.message;
    }
    return 1;
  }
}

const event = { event: 'candidate_promotion', started_at: new Date().toISOString() };
let failedStage = 'arguments';
try {
  const settings = verificationSettings();
  event.settings = settings;
  failedStage = 'routing_lock';
  process.exitCode = await withRoutingLock(() => promote(event, settings));
} catch (error) {
  event.status = 'PROMOTION_FAILED';
  event.failed_stage = failedStage;
  event.reason = error.message;
  process.exitCode = 1;
}
event.completed_at = new Date().toISOString();
console.log(JSON.stringify(event, null, 2));
