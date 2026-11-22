import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const proxyUrl = 'http://127.0.0.1:18080/api/work';
const project = 'health-aware-workflow-comparison';
const dockerArgs = ['compose', '--profile', 'routing'];
const node = process.execPath;
const driverRate = 5;
const driverDurationSeconds = 120;
const driverWarmupSeconds = 5;
const deployAfterSpawnMs = 15_000;
const observationWindowMs = 60_000;
const nsPerMs = 1_000_000n;
const clockSource = 'process.hrtime.bigint';
const clockVersion = 1;
const interrupted = new AbortController();

function start(file, args, timeout = 30_000) {
  const { promise, resolve } = Promise.withResolvers();
  const child = execFile(file, args, { timeout, maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  return { child, finished: promise };
}

async function run(file, args, timeout) {
  return start(file, args, timeout).finished;
}

function requireSuccess(result, label) {
  if (result.error) throw new Error(label + ': ' + (result.stderr.trim() || result.error.message));
  return result.stdout.trim();
}

function stamp() {
  const hostNs = process.hrtime.bigint();
  return {
    host_monotonic_ns: hostNs.toString(),
    wall_ms: Date.now(),
    monotonic_ms: performance.now()
  };
}

function hostNs(stamp) {
  return BigInt(stamp.host_monotonic_ns);
}

async function waitUntil(deadlineNs, signal = interrupted.signal) {
  let remainingNs = deadlineNs - process.hrtime.bigint();
  while (remainingNs > 0n) {
    await sleep(Math.max(1, Number(remainingNs) / Number(nsPerMs)), undefined, { signal });
    remainingNs = deadlineNs - process.hrtime.bigint();
  }
  signal.throwIfAborted();
}

function driverClockBounds(clock) {
  const fields = ['start_before_ns', 'start_after_ns', 'end_before_ns', 'end_after_ns', 'elapsed_ns'];
  if (clock?.version !== clockVersion || clock.source !== clockSource ||
      !fields.every(key => typeof clock[key] === 'string' && /^\d+$/.test(clock[key]))) return null;

  const [startBefore, startAfter, endBefore, endAfter, elapsed] = fields.map(key => BigInt(clock[key]));
  if (startBefore > startAfter || startAfter > endBefore || endBefore > endAfter || elapsed === 0n) return null;

  // Project the end sample back to the start. Allow 1 ns for rounding the elapsed offset.
  const endLower = endBefore - elapsed - 1n;
  const endUpper = endAfter - elapsed + 1n;
  const lower = startBefore > endLower ? startBefore : endLower;
  const upper = startAfter < endUpper ? startAfter : endUpper;
  return lower <= upper ? { lower, upper, endBefore, endAfter } : null;
}

async function checkCandidateFaultIsAbsent() {
  const args = [...dockerArgs, 'exec', '-T', 'candidate', 'sh', '-eu', '-c',
    'test -n "$WORKLOAD_FAULT_FILE"; test ! -e "$WORKLOAD_FAULT_FILE"'];
  requireSuccess(await run('docker', args, 10_000), 'Candidate workload fault must be absent');
}

function hasVersion(observation, status, version) {
  return observation.http_status === status && observation.version === version;
}

function importController(name) {
  return import(pathToFileURL(resolve('tools/controller', name)));
}

async function restoreHealthAware(id, record) {
  const {
    readDeployment, readRoutingState, withRoutingLock, writeAtomic,
    writeDeployment, writeRoutingState
  } = await importController('deployment-state.mjs');
  const { rollbackDeployment } = await importController('rollback.mjs');
  const { configPath, nginx, readRuntimeConfig, verifyProxy } =
    await importController('nginx-routing.mjs');

  record('health_aware_cleanup_started', { deployment_id: id });
  try {
    await withRoutingLock(async () => {
      const state = readRoutingState();
      const active = state.deployment_id === id && state.pending_deployment_id === null;
      const pending = state.pending_deployment_id === id && state.deployment_id === null;
      assert(active || pending, 'Pilot promotion no longer owns the active or pending route');

      const deployment = readDeployment(id);
      const { manifest, previous, candidate } = deployment;
      assert(manifest.workflow !== 'conventional', 'Health-aware cleanup requires a health-aware deployment');
      assert.equal(manifest.previous_version, '1.0.0', 'Unexpected stable version in promotion snapshot');

      if (active) {
        // The shared rollback helper verifies the installed snapshot and the recovered route.
        const result = await rollbackDeployment(deployment, null);
        record('health_aware_cleanup_result', { deployment_id: id, result });
        assert.equal(result.status, 'ROLLED_BACK', 'Health-aware rollback did not complete');
        return;
      }

      // An interrupted promotion can leave either saved snapshot installed.
      const current = readRuntimeConfig();
      assert(current.equals(previous) || current.equals(candidate),
        'Installed config differs from both promotion snapshots');
      if (!current.equals(previous)) writeAtomic(configPath, previous, manifest.config_mode);
      nginx('-t');
      nginx('-s', 'reload');
      const verification = await verifyProxy(manifest.previous_version, {
        verification_window_ms: 5000,
        verification_interval_ms: 200
      });
      record('health_aware_cleanup_verification', { deployment_id: id, verification });
      assert(verification.passed, 'Could not verify the stable route after interrupted promotion');
      writeDeployment(manifest, {
        status: 'PROMOTION_INTERRUPTED',
        recovery: { status: 'RESTORED', file_restored: true, verification }
      });
      writeRoutingState(null, null);
      record('health_aware_cleanup_result', { deployment_id: id, status: 'RESTORED' });
    });
  } catch (error) {
    record('health_aware_cleanup_failed', { deployment_id: id, message: error.message });
    throw error;
  }
}

async function runArm(arm, pairDir, observeProxy, readRoutingState) {
  interrupted.signal.throwIfAborted();
  const initial = await observeProxy(1000);
  assert(hasVersion(initial, 200, '1.0.0'), arm + ' must start on the healthy stable route');
  const initialState = readRoutingState();
  assert.deepEqual([initialState.deployment_id, initialState.pending_deployment_id], [null, null]);
  await checkCandidateFaultIsAbsent();

  const armDir = join(pairDir, arm);
  mkdirSync(armDir);
  const record = (event, fields = {}, time = stamp()) => appendFileSync(
    join(armDir, 'events.jsonl'), JSON.stringify({ event, ...time, ...fields }) + '\n'
  );

  async function controller(label, args, invokedAt = stamp()) {
    record(label + '_invoked', {}, invokedAt);
    const result = await run(node, args, 35_000);
    record(label + '_returned', { exit_code: result.error?.code ?? 0 });
    writeFileSync(join(armDir, label + '.json'), result.stdout);
    writeFileSync(join(armDir, label + '.stderr.log'), result.stderr);
    return { ...result, event: JSON.parse(result.stdout) };
  }

  const launchedAt = stamp();
  const driver = start(node, [
    'tools/driver/driver.js', '--url', proxyUrl, '--rate', String(driverRate),
    '--duration', String(driverDurationSeconds), '--warmup', String(driverWarmupSeconds),
    '--timeout', '3000', '--out', armDir, '--run-id', 'workload'
  ], 150_000);
  record('driver_spawned', { url: proxyUrl }, launchedAt);
  console.log(arm + ' arm started');

  const stopDriver = () => driver.child.kill('SIGTERM');
  interrupted.signal.addEventListener('abort', stopDriver, { once: true });
  const stopObserver = new AbortController();
  const observerSignal = AbortSignal.any([interrupted.signal, stopObserver.signal]);
  let origin;
  let cutoffNs;
  let deployment;
  let monitor;
  let monitorResult;
  let driverResult;
  let summary;
  let observerFailure;
  let firstCandidate;
  let candidateVerified;
  let consecutiveCandidate = 0;
  let unhealthyObservations = 0;
  let regressionsAfterVerification = 0;

  const observer = (async () => {
    let nextProbeNs = hostNs(launchedAt);
    try {
      while (cutoffNs === undefined || nextProbeNs < cutoffNs) {
        await waitUntil(nextProbeNs, observerSignal);
        const begun = stamp();
        if (cutoffNs !== undefined && hostNs(begun) >= cutoffNs) break;
        const result = await observeProxy(1000, { versionStatuses: [200, 500] });
        const completed = stamp();
        record('external_probe', { started_at: begun, ...result }, completed);

        if (origin && hostNs(begun) >= hostNs(origin) && hostNs(completed) < cutoffNs) {
          const isCandidate = hasVersion(result, 200, '2.0.0');
          if (!isCandidate && !hasVersion(result, 200, '1.0.0')) unhealthyObservations++;
          if (candidateVerified && !isCandidate) regressionsAfterVerification++;
          if (isCandidate && !firstCandidate) {
            firstCandidate = completed;
            record('first_candidate_success', {}, completed);
          }
          consecutiveCandidate = isCandidate ? consecutiveCandidate + 1 : 0;
          if (!candidateVerified && consecutiveCandidate === 3) {
            candidateVerified = completed;
            record('candidate_externally_verified', { consecutive_successes: 3 }, completed);
          }
        }

        const nextCadence = hostNs(begun) + 1000n * nsPerMs;
        nextProbeNs = nextCadence > hostNs(completed) ? nextCadence : hostNs(completed);
      }
    } catch (error) {
      if (!observerSignal.aborted) observerFailure = error;
    }
  })();

  async function stopMonitor() {
    if (!monitor || monitorResult) return;
    const stoppedByRunner = monitor.child.kill('SIGTERM');
    const result = await monitor.finished;
    monitorResult = { ...result, stoppedByRunner };
    writeFileSync(join(armDir, 'monitor.jsonl'), result.stdout);
    writeFileSync(join(armDir, 'monitor.stderr.log'), result.stderr);
    record('monitor_stopped', {
      stopped_by_runner: stoppedByRunner,
      exit_code: result.error?.code ?? 0,
      signal: result.error?.signal ?? null
    });
  }

  try {
    const early = await Promise.race([
      waitUntil(hostNs(launchedAt) + BigInt(deployAfterSpawnMs) * nsPerMs).then(() => false),
      driver.finished.then(() => true)
    ]);
    assert(!early, 'Driver exited before deployment');

    const healthAware = arm === 'health-aware';
    origin = stamp();
    cutoffNs = hostNs(origin) + BigInt(observationWindowMs) * nsPerMs;
    record('deployment_window_started', {
      window_ms: observationWindowMs,
      cutoff_host_monotonic_ns: cutoffNs.toString()
    }, origin);
    const label = healthAware ? 'promotion' : 'switch';
    const args = healthAware ? ['tools/controller/promote.mjs'] :
      ['tools/controller/conventional-release.mjs', 'switch'];
    deployment = await controller(label, args, origin);

    if (healthAware && !deployment.error && deployment.event.status === 'PROMOTED' &&
        deployment.event.deployment_id && process.hrtime.bigint() < cutoffNs) {
      record('monitor_invoked', { deployment_id: deployment.event.deployment_id });
      monitor = start(node, ['tools/controller/monitor.mjs', deployment.event.deployment_id], 150_000);
    }

    await waitUntil(cutoffNs);
    await observer;
    if (observerFailure) throw observerFailure;
    record('observation_window_closed');
    await stopMonitor();
    driverResult = await driver.finished;
    const driverFinishObserved = stamp();
    record('driver_finish_observed', { exit_code: driverResult.error?.code ?? 0 }, driverFinishObserved);
    interrupted.signal.throwIfAborted();

    const workload = JSON.parse(readFileSync(join(armDir, 'workload', 'run.json'), 'utf8'));
    const failures = [];
    function check(condition, message) {
      if (!condition) failures.push(message);
    }

    check(!driverResult.error && workload.status === 'complete', 'Workload driver did not complete successfully');
    check(workload.summary?.offered === driverRate * driverDurationSeconds,
      'Driver did not report 600 offered slots');
    const bounds = driverClockBounds(workload.clock_alignment);
    check(bounds !== null, 'Driver start and end clock anchors are missing, malformed, or disagree');
    if (bounds) {
      check(bounds.lower >= hostNs(launchedAt) && bounds.endAfter <= hostNs(driverFinishObserved),
        'Driver clock anchors fall outside the runner launch-to-finish interval');
      check(bounds.upper + BigInt(driverWarmupSeconds * 1000) * nsPerMs <= hostNs(origin),
        'Deployment began before the driver warm-up ended');
      check(cutoffNs <= bounds.lower + BigInt(driverDurationSeconds * 1000) * nsPerMs &&
        cutoffNs <= bounds.endBefore, 'Driver schedule did not cover the observation window');
    }
    const expected = healthAware ? 'PROMOTED' : 'SWITCHED';
    check(!deployment.error && deployment.event.status === expected && deployment.event.deployment_id,
      'Deployment command did not report ' + expected + ' with a deployment ID');
    check(candidateVerified, 'Candidate did not produce three consecutive HTTP 200 probes before cutoff');
    check(unhealthyObservations === 0, 'Observer saw an unhealthy response in the measurement window');
    check(regressionsAfterVerification === 0,
      'Observer saw the candidate route regress after external verification');
    if (healthAware) {
      check(monitorResult?.stoppedByRunner && monitorResult.error?.signal === 'SIGTERM',
        'Health-aware monitor did not stay running until the runner stopped it');
      check(monitorResult && !monitorResult.stdout.trim() && !monitorResult.stderr.trim(),
        'Health-aware monitor reported an event or error during the healthy window');
    }

    summary = {
      arm,
      status: failures.length ? 'checks_failed' : 'passed',
      failed_checks: failures,
      deployment_status: deployment.event.status,
      driver_status: workload.status ?? null,
      driver_offered: workload.summary?.offered ?? null,
      deployment_to_first_candidate_ms: firstCandidate
        ? Number(hostNs(firstCandidate) - hostNs(origin)) / Number(nsPerMs) : null,
      deployment_to_candidate_verified_ms: candidateVerified
        ? Number(hostNs(candidateVerified) - hostNs(origin)) / Number(nsPerMs) : null,
      unhealthy_observations: unhealthyObservations,
      regressions_after_verification: regressionsAfterVerification,
      shared_clock: {
        source: clockSource,
        version: clockVersion,
        unit: 'ns',
        driver_start_lower_ns: bounds?.lower.toString() ?? null,
        driver_start_upper_ns: bounds?.upper.toString() ?? null,
        driver_start_bound_width_ns: bounds ? (bounds.upper - bounds.lower).toString() : null,
        cohort_start_ns: origin.host_monotonic_ns,
        cohort_cutoff_ns: cutoffNs.toString(),
        first_candidate_success_ns: firstCandidate?.host_monotonic_ns ?? null,
        candidate_externally_verified_ns: candidateVerified?.host_monotonic_ns ?? null
      }
    };
  } catch (error) {
    record('arm_execution_error', { message: error.message });
    throw error;
  } finally {
    stopObserver.abort();
    interrupted.signal.removeEventListener('abort', stopDriver);
    await observer;
    await stopMonitor();
    if (!driverResult && driver.child.exitCode === null && driver.child.signalCode === null) {
      driver.child.kill('SIGTERM');
    }
    driverResult ??= await driver.finished;
    writeFileSync(join(armDir, 'driver.stdout.log'), driverResult.stdout);
    writeFileSync(join(armDir, 'driver.stderr.log'), driverResult.stderr);

    let state = readRoutingState();
    const owner = state.deployment_id ?? state.pending_deployment_id;
    if (owner !== null) {
      assert.equal(owner, deployment?.event.deployment_id,
        'Cleanup refused to change unconfirmed routing owner ' + owner);
      if (arm === 'health-aware') {
        await restoreHealthAware(owner, record);
      } else {
        const restored = await controller('cleanup_restore',
          ['tools/controller/conventional-release.mjs', 'restore', owner]);
        requireSuccess(restored, 'Conventional cleanup restore');
        assert.equal(restored.event.status, 'RESTORED');
      }
    }
    state = readRoutingState();
    assert.deepEqual([state.deployment_id, state.pending_deployment_id], [null, null],
      'Routing ownership must be clear after the arm');
    let final;
    for (let attempt = 0; attempt < 5; attempt++) {
      final = await observeProxy(1000);
      record('reset_route_observed', final);
      if (hasVersion(final, 200, '1.0.0')) break;
      if (attempt < 4) await sleep(500);
    }
    assert(hasVersion(final, 200, '1.0.0'), 'Stable route was not verified after cleanup');
  }
  writeFileSync(join(armDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

async function main() {
  assert.equal(process.argv.length, 2, 'Run this pilot without arguments from workflow-comparison');
  const branch = requireSuccess(await run('git', ['branch', '--show-current']), 'Read Git branch');
  assert.equal(branch, 'workflow-comparison');
  assert.equal(process.env.COMPOSE_PROJECT_NAME, project);
  assert.equal(process.env.DEPLOYMENT_PROXY_URL, proxyUrl);
  const bind = requireSuccess(await run('docker', [...dockerArgs, 'port', 'nginx', '80']), 'Check proxy port');
  assert.equal(bind, '127.0.0.1:18080');

  const { observeProxy } = await importController('observe-proxy.mjs');
  const { readRoutingState } = await importController('deployment-state.mjs');
  const label = new Date().toISOString().replace(/[:.]/g, '-');
  const pairDir = resolve('experiments/results', 'healthy-release-pilot-' + label + '-' + randomUUID().slice(0, 8));
  mkdirSync(pairDir, { recursive: true });
  console.log('Pilot evidence directory:', pairDir);

  const arms = [];
  let executionError;
  try {
    for (const arm of ['health-aware', 'conventional']) {
      arms.push(await runArm(arm, pairDir, observeProxy, readRoutingState));
    }
  } catch (error) {
    executionError = error;
  }
  const checksPassed = arms.length === 2 && arms.every(arm => arm.status === 'passed');
  const status = executionError ? 'incomplete' : checksPassed ? 'passed' : 'checks_failed';
  writeFileSync(join(pairDir, 'pilot-summary.json'), JSON.stringify({
    scenario: 'healthy_release',
    proxy_url: proxyUrl,
    cohort_clock: { source: clockSource, version: clockVersion, unit: 'ns' },
    status,
    execution_error: executionError?.message ?? null,
    arms
  }, null, 2) + '\n');
  if (executionError) throw executionError;
  console.log('Pilot status:', status);
  if (!checksPassed) process.exitCode = 1;
}

const onInterrupt = () => interrupted.abort(new Error('Pilot interrupted'));
process.once('SIGINT', onInterrupt);
process.once('SIGTERM', onInterrupt);
try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onInterrupt);
}
