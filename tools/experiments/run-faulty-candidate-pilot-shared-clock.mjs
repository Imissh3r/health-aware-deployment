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
const faultAfterSpawnMs = 15_000;
const observationWindowMs = 60_000;
const operatorDelayMs = 10_000;
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

async function candidateFault(command) {
  const script = {
    set: 'test -n "$WORKLOAD_FAULT_FILE"; set -C; : > "$WORKLOAD_FAULT_FILE"',
    clear: 'test -n "$WORKLOAD_FAULT_FILE"; rm -f -- "$WORKLOAD_FAULT_FILE"'
  }[command];
  const args = [...dockerArgs, 'exec', '-T', 'candidate', 'sh', '-eu', '-c', script];
  requireSuccess(await run('docker', args, 10_000), 'Candidate fault ' + command);
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
  let state = readRoutingState();
  assert.deepEqual([state.deployment_id, state.pending_deployment_id], [null, null]);

  const armDir = join(pairDir, arm);
  mkdirSync(armDir);
  const record = (event, fields = {}, time = stamp()) => appendFileSync(
    join(armDir, 'events.jsonl'), JSON.stringify({ event, ...time, ...fields }) + '\n'
  );

  async function controller(label, args) {
    record(label + '_invoked');
    const result = await run(node, args, 35_000);
    record(label + '_returned', { exit_code: result.error?.code ?? 0 });
    writeFileSync(join(armDir, label + '.json'), result.stdout);
    writeFileSync(join(armDir, label + '.stderr.log'), result.stderr);
    return { ...result, event: JSON.parse(result.stdout) };
  }

  const spawnedAt = stamp();
  const driver = start(node, [
    'tools/driver/driver.js', '--url', proxyUrl, '--rate', String(driverRate),
    '--duration', String(driverDurationSeconds), '--warmup', String(driverWarmupSeconds),
    '--timeout', '3000', '--out', armDir, '--run-id', 'workload'
  ], 150_000);
  record('driver_spawned', { url: proxyUrl }, spawnedAt);
  console.log(arm + ' arm started');

  const stopDriver = () => driver.child.kill('SIGTERM');
  interrupted.signal.addEventListener('abort', stopDriver, { once: true });
  const stopObserver = new AbortController();
  const observerSignal = AbortSignal.any([interrupted.signal, stopObserver.signal]);
  const alertReady = Promise.withResolvers();
  let faultSet = false;
  let origin;
  let cutoffNs;
  let alert;
  let restoreInvoked;
  let operatorRestore;
  let stableVerified;
  let consecutiveFailures = 0;
  let consecutiveStable = 0;
  let deployment;
  let driverResult;
  let summary;
  let observerFailure;

  const observer = (async () => {
    let nextProbeNs = hostNs(spawnedAt);
    try {
      while (cutoffNs === undefined || nextProbeNs < cutoffNs) {
        await waitUntil(nextProbeNs, observerSignal);
        const begun = stamp();
        if (cutoffNs !== undefined && hostNs(begun) >= cutoffNs) break;
        const observation = await observeProxy(1000, { versionStatuses: [200, 500] });
        const completed = stamp();
        record('external_probe', { started_at: begun, ...observation }, completed);
        if (origin && hostNs(begun) >= hostNs(origin) && hostNs(completed) < cutoffNs) {
          const failed = hasVersion(observation, 500, '2.0.0');
          consecutiveFailures = failed ? consecutiveFailures + 1 : 0;
          if (!alert && consecutiveFailures === 3) {
            alert = completed;
            record('external_alert', { consecutive_failures: 3 }, alert);
            alertReady.resolve(alert);
          }
          if (restoreInvoked && hostNs(begun) >= hostNs(restoreInvoked)) {
            const stable = hasVersion(observation, 200, '1.0.0');
            consecutiveStable = stable ? consecutiveStable + 1 : 0;
            if (!stableVerified && consecutiveStable === 3) {
              stableVerified = completed;
              record('external_restoration_verified', { consecutive_successes: 3 }, stableVerified);
            }
          }
        }
        const nextCadenceNs = hostNs(begun) + 1000n * nsPerMs;
        nextProbeNs = nextCadenceNs > hostNs(completed) ? nextCadenceNs : hostNs(completed);
      }
    } catch (error) {
      if (!observerSignal.aborted) observerFailure = error;
    } finally {
      alertReady.resolve(null);
    }
  })();

  async function restore(label, id) {
    const result = await controller(label, ['tools/controller/conventional-release.mjs', 'restore', id]);
    requireSuccess(result, label);
    assert.equal(result.event.status, 'RESTORED');
  }

  try {
    const early = await Promise.race([
      waitUntil(hostNs(spawnedAt) + BigInt(faultAfterSpawnMs) * nsPerMs).then(() => false),
      driver.finished.then(() => true)
    ]);
    assert(!early, 'Driver exited before fault injection');

    await candidateFault('set');
    faultSet = true;
    origin = stamp();
    cutoffNs = hostNs(origin) + BigInt(observationWindowMs) * nsPerMs;
    record('fault_acknowledged', {
      window_ms: observationWindowMs,
      cutoff_wall_ms: origin.wall_ms + observationWindowMs,
      cutoff_monotonic_ms: origin.monotonic_ms + observationWindowMs,
      cutoff_host_monotonic_ns: cutoffNs.toString()
    }, origin);

    if (arm === 'health-aware') {
      deployment = await controller('promotion', ['tools/controller/promote.mjs']);
    } else {
      deployment = await controller('switch', ['tools/controller/conventional-release.mjs', 'switch']);
      requireSuccess(deployment, 'Conventional switch');
      assert.equal(deployment.event.status, 'SWITCHED');
      assert(deployment.event.deployment_id, 'Switch did not report a deployment ID');
      const detectedAt = await alertReady.promise;
      interrupted.signal.throwIfAborted();
      if (observerFailure) throw observerFailure;
      if (detectedAt) {
        const operatorDueNs = hostNs(detectedAt) + BigInt(operatorDelayMs) * nsPerMs;
        if (operatorDueNs < cutoffNs) {
          await waitUntil(operatorDueNs);
          const due = stamp();
          if (hostNs(due) < cutoffNs) {
            restoreInvoked = due;
            record('operator_restore_started', { scripted_delay_ms: operatorDelayMs }, restoreInvoked);
            operatorRestore = await controller('operator_restore', [
              'tools/controller/conventional-release.mjs', 'restore', deployment.event.deployment_id
            ]);
          }
        }
      }
    }

    await waitUntil(cutoffNs);
    await observer;
    if (observerFailure) throw observerFailure;
    record('observation_window_closed');
    driverResult = await driver.finished;
    const driverFinishObserved = stamp();
    record('driver_finish_observed', { exit_code: driverResult.error?.code ?? 0 }, driverFinishObserved);
    interrupted.signal.throwIfAborted();
    const workload = JSON.parse(readFileSync(join(armDir, 'workload', 'run.json'), 'utf8'));
    const failures = [];
    function check(condition, message) {
      if (!condition) failures.push(message);
    }

    check(!driverResult.error, 'Workload driver did not exit successfully');
    check(workload.status === 'complete', 'Driver run.json status was not complete');
    check(workload.summary?.offered === driverRate * driverDurationSeconds,
      'Driver did not report 600 offered slots');
    const driverStart = workload.wall_start_ms;
    check(Number.isSafeInteger(driverStart), 'Driver did not provide a valid wall_start_ms');
    const bounds = driverClockBounds(workload.clock_alignment);
    check(bounds !== null, 'Driver start and end clock anchors are missing, malformed, or disagree');
    if (bounds) {
      check(bounds.lower >= hostNs(spawnedAt) && bounds.endAfter <= hostNs(driverFinishObserved),
        'Driver clock anchors fall outside the runner launch-to-finish interval');
      check(bounds.upper + BigInt(driverWarmupSeconds * 1000) * nsPerMs <= hostNs(origin),
        'Fault was acknowledged before the driver warm-up ended');
      check(cutoffNs <= bounds.lower + BigInt(driverDurationSeconds * 1000) * nsPerMs &&
        cutoffNs <= bounds.endBefore, 'Driver schedule did not cover the observation window');
    }

    const delayNs = alert && restoreInvoked ? hostNs(restoreInvoked) - hostNs(alert) : null;
    const delay = delayNs === null ? null : Number(delayNs) / Number(nsPerMs);
    if (arm === 'health-aware') {
      const validation = deployment.event.validation;
      check(deployment.error?.code === 2, 'Promotion did not exit with rejection code 2');
      check(deployment.event.status === 'PROMOTION_BLOCKED', 'Promotion did not report PROMOTION_BLOCKED');
      check(validation?.status === 'REJECTED', 'Candidate validation did not report REJECTED');
      check(validation?.workload_counts?.attempted === 5 && validation.workload_counts.failed === 5,
        'Candidate validation did not report five failures in five workload attempts');
    } else {
      check(alert !== undefined, 'No qualifying baseline alert before cutoff');
      check(delayNs !== null && delayNs >= BigInt(operatorDelayMs) * nsPerMs,
        'Operator restore did not start after the full 10-second delay');
      check(operatorRestore && !operatorRestore.error && operatorRestore.event.status === 'RESTORED' &&
        operatorRestore.event.deployment_id === deployment.event.deployment_id,
        'Operator command did not restore the switched deployment');
      check(stableVerified !== undefined, 'Previous version was not externally verified before cutoff');
    }

    summary = {
      arm,
      status: failures.length ? 'checks_failed' : 'passed',
      failed_checks: failures,
      deployment_status: deployment.event.status,
      driver_status: workload.status ?? null,
      driver_offered: workload.summary?.offered ?? null,
      driver_wall_start_ms: driverStart ?? null,
      cohort_start_ms: origin.wall_ms,
      cohort_cutoff_ms: origin.wall_ms + observationWindowMs,
      external_alert_ms: alert?.wall_ms ?? null,
      operator_restore_started_ms: restoreInvoked?.wall_ms ?? null,
      operator_delay_elapsed_ms: delay,
      operator_restore_status: operatorRestore?.event.status ?? null,
      external_restoration_verified_ms: stableVerified?.wall_ms ?? null,
      shared_clock: {
        source: clockSource,
        version: clockVersion,
        unit: 'ns',
        driver_start_lower_ns: bounds?.lower.toString() ?? null,
        driver_start_upper_ns: bounds?.upper.toString() ?? null,
        driver_start_bound_width_ns: bounds ? (bounds.upper - bounds.lower).toString() : null,
        cohort_start_ns: origin.host_monotonic_ns,
        cohort_cutoff_ns: cutoffNs.toString(),
        external_alert_ns: alert?.host_monotonic_ns ?? null,
        operator_restore_started_ns: restoreInvoked?.host_monotonic_ns ?? null,
        external_restoration_verified_ns: stableVerified?.host_monotonic_ns ?? null
      }
    };
  } catch (error) {
    record('arm_execution_error', { message: error.message });
    throw error;
  } finally {
    stopObserver.abort();
    interrupted.signal.removeEventListener('abort', stopDriver);
    await observer;
    if (!driverResult && driver.child.exitCode === null && driver.child.signalCode === null) {
      driver.child.kill('SIGTERM');
    }
    driverResult ??= await driver.finished;
    writeFileSync(join(armDir, 'driver.stdout.log'), driverResult.stdout);
    writeFileSync(join(armDir, 'driver.stderr.log'), driverResult.stderr);

    try {
      state = readRoutingState();
      const routeOwner = state.deployment_id ?? state.pending_deployment_id;
      if (routeOwner !== null) {
        assert.equal(routeOwner, deployment?.event.deployment_id,
          'Cleanup refused to change unconfirmed routing owner ' + routeOwner);
        if (arm === 'health-aware') {
          await restoreHealthAware(routeOwner, record);
        } else {
          await restore('cleanup_restore', routeOwner);
        }
      }
    } finally {
      if (faultSet) {
        await candidateFault('clear');
        record('fault_cleared');
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
  const pairDir = resolve('experiments/results', 'faulty-candidate-pilot-' + label + '-' + randomUUID().slice(0, 8));
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
    scenario: 'faulty_candidate_before_switch',
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
