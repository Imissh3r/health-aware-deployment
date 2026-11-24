import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFormalFaultyCandidate } from './run-formal-faulty-candidate.mjs';

const second = 1_000_000_000n;
const base = 1000n * second;
const frozen = { project: 's2-fixture', proxyUrl: 'http://127.0.0.1:18080/api/work',
  stableConfigSha256: '0'.repeat(64), environmentFingerprint: 's2-fixture' };
const clear = { deployment_id: null, pending_deployment_id: null };
const owner = { ...clear, deployment_id: 'fixture' };
const stable = { http_status: 200, version: '1.0.0' };
const faulty = { http_status: 500, version: '2.0.0' };

async function fixture(t, cfg = {}) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'formal-s2-'));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const arm = cfg.arm ?? 'C';
  let now = base;
  let flag = false;
  let state = clear;
  let invoke;
  let switchedAt;
  let restoredAt;
  let driverStopped = false;
  let restoreCount = 0;
  const events = [];
  const queue = [];
  const schedule = (at, callback) => queue.push({ at, callback });
  const start = base + second;
  const clock = {
    source: 'process.hrtime.bigint', version: 1,
    start_before_ns: String(start - 10n), start_after_ns: String(start + 10n)
  };
  const driver = Promise.withResolvers();
  const note = name => events.push([name, now]);
  function outcome(status, { exitCode = 0, timedOut = false, event = 'conventional_release', action } = {}) {
    return { stdout: JSON.stringify({ event, status, action, deployment_id: owner.deployment_id }),
      stderr: timedOut ? 'timeout evidence' : '', timedOut, exitCode };
  }
  const ops = {
    now: () => now,
    waitUntil(at, signal) {
      if (now >= at || signal?.aborted) return Promise.resolve();
      return new Promise(resolve => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          resolve();
        };
        signal?.addEventListener('abort', wake, { once: true });
        schedule(at, () => { if (!signal?.aborted) wake(); });
      });
    },
    async preflight() { assert.equal(flag, false); },
    routingState: () => state,
    startDriver(args, receive) {
      const arg = name => args[args.indexOf('--' + name) + 1];
      assert.ok(args.includes('--notify-start'));
      assert.deepEqual(['rate', 'duration', 'warmup', 'timeout', 'max-concurrency', 'max-lateness'].map(arg),
        ['5', '120', '5', '3000', '50', '200']);
      const runId = arg('run-id');
      if (!cfg.noNotification) schedule(start + 20n, () => receive({
        event: 'driver_start', run_id: runId, clock_alignment: clock
      }));
      const duration = cfg.duration ?? 120;
      const finish = start + BigInt(duration) * second;
      schedule(finish, () => {
        if (driverStopped) return;
        note('driver_finished');
        const path = join(arg('out'), runId);
        mkdirSync(path);
        writeFileSync(join(path, 'run.json'), JSON.stringify({
          run_id: runId, status: duration === 120 ? 'complete' : 'incomplete', target_url: frozen.proxyUrl,
          options: { rate: 5, duration_seconds: 120, warmup_seconds: 5, timeout_ms: 3000,
            max_concurrency: 50, max_lateness_ms: 200 },
          clock_alignment: { ...clock,
            ...(cfg.badBracket && { start_before_ns: String(start - 11n) }),
            end_before_ns: String(finish - 10n), end_after_ns: String(finish), elapsed_ns: String(finish - start) }
        }));
        const header = 'run_id,seq,scheduled_ms,dispatched_ms,completed_ms,dispatch_delay_ms,latency_ms,outcome,http_status,error_code,miss_reason,version,warmup';
        const rows = Array.from({ length: 5 * duration }, (_, index) => {
          const ms = index * 200;
          const at = start + BigInt(ms) * 1_000_000n;
          const exposed = switchedAt && at >= switchedAt && (!restoredAt || at < restoredAt);
          if (cfg.miss && ms === 15000) return [runId, index + 1, ms, '', '', '', '', 'missed', '', '', 'late', '', false].join(',');
          return [runId, index + 1, ms, ms, ms + 10, 0, 10, exposed ? 'http_error' : 'ok', exposed ? 500 : 200,
            '', '', exposed ? '2.0.0' : '1.0.0', ms < 5000].join(',');
        });
        writeFileSync(join(path, 'requests.csv'), [header, ...rows].join('\n') + '\n');
        driver.resolve({ exitCode: duration === 120 ? 0 : 1 });
      });
      return { finished: driver.promise, stop() {
        driverStopped = true;
        driver.resolve({ signal: 'SIGTERM' });
      } };
    },
    driverRunning: () => !driverStopped,
    async writeFault(onInvoke) {
      onInvoke();
      note('fault_written');
      flag = cfg.writeFails !== true;
      if (cfg.writeTimeout) return { timedOut: true, signal: 'SIGKILL', stdout: 'partial fault evidence' };
      return { exitCode: cfg.writeFails ? 1 : 0 };
    },
    async candidateProbe(path) {
      note(path);
      now += 20_000_000n;
      return { http_status: path === '/api/work' && !cfg.badConfirmation ? 500 : 200,
        version: path === '/api/work' ? '2.0.0' : null,
        completed_monotonic_ns: String(cfg.badProbeClock ? now + second : now) };
    },
    async observe() {
      if (invoke && cfg.observerFails) throw new Error('fixture observer unavailable');
      if (!invoke && cfg.preparationDelay) now += BigInt(cfg.preparationDelay) * second;
      note('probe');
      if (!invoke || state !== owner || (cfg.noAlert && (now - invoke) % (3n * second) === 0n) ||
          (cfg.lateAlert && now < invoke + BigInt(cfg.lateAlert) * second)) return stable;
      return faulty;
    },
    async deploy() {
      invoke = now;
      note('deploy');
      const status = cfg.deployment ?? (arm === 'H' ? 'PROMOTION_BLOCKED' : 'SWITCHED');
      if (['SWITCHED', 'PROMOTED'].includes(status) || cfg.deployTimeout || cfg.transientExposure) {
        state = owner;
        switchedAt = now;
      }
      if (cfg.transientExposure) schedule(now + 3n * second, () => { state = clear; restoredAt = now; });
      if (cfg.deployTimeout) return outcome(status, { timedOut: true, exitCode: null,
        event: arm === 'H' ? 'candidate_promotion' : 'conventional_release', action: 'switch' });
      if (cfg.malformedDeployment) return { exitCode: 1, stdout: '{}', stderr: 'parse evidence' };
      return outcome(status, { exitCode: ['SWITCHED', 'PROMOTED'].includes(status) ? 0 : 1,
        event: arm === 'H' ? 'candidate_promotion' : 'conventional_release', action: 'switch' });
    },
    startMonitor(id, _horizon, publish) {
      const finished = Promise.withResolvers();
      note('monitor');
      if (!cfg.hungMonitor) schedule(now + 4n * second, () => {
        const occurred = now;
        restoredAt = now + second;
        schedule(restoredAt, () => {
          state = clear;
          publish({ type: 'timing', value: { event: 'locked_degradation_confirmed',
            occurred_monotonic_ns: String(occurred), deployment_id: id } });
          publish({ type: 'report', value: { status: 'ROLLED_BACK' } });
          publish({ type: 'status', value: { status: 'ROLLED_BACK' } });
          finished.resolve({ exitCode: 0 });
        });
      });
      return { finished: finished.promise, stop() { note('monitor_stop'); } };
    },
    async restore(_arm, _id, capture, onInvoke) {
      onInvoke?.();
      const workflow = restoreCount++ === 0 && cfg.noAlert !== true;
      note(workflow ? 'restore' : 'cleanup_restore');
      if (workflow && cfg.restoreTimeout) {
        capture(outcome('RESTORED', { timedOut: true, exitCode: null, action: 'restore' }));
        throw new Error('fixture restore timeout');
      }
      if (workflow && cfg.restoreFails) {
        capture(outcome('FAILED', { exitCode: 1, action: 'restore' }));
        throw new Error('fixture restore failure');
      }
      if (capture && (cfg.arm ?? 'C') === 'C') capture(outcome('RESTORED', { action: 'restore' }));
      state = clear;
      restoredAt ??= now;
      return { status: 'RESTORED' };
    },
    async faultState() { note('flag_inspection'); return { present: flag }; },
    async verifyStableForFaultClear() { assert.equal(state, clear); },
    async clearFault() {
      note('clear_fault');
      if (cfg.cleanupFails) return { exitCode: 1 };
      flag = false;
      return { exitCode: 0 };
    },
    async reset() { note('reset'); assert.equal(flag, false); assert.equal(state, clear); }
  };
  const promise = runFormalFaultyCandidate({ arm, trialId: 'trial', evidenceRoot, frozen }, ops);
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let iteration = 0; !done && iteration < 500; iteration++) {
    await new Promise(resolve => setImmediate(resolve));
    if (done) break;
    queue.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    const next = queue.shift();
    assert.ok(next, 'Runner stalled without a scheduled operation');
    if (next.at > now) now = next.at;
    next.callback();
  }
  assert.ok(done, 'Runner did not settle');
  const result = await promise;
  const read = file => readFile(join(result.directory, file), 'utf8');
  return { result, events, read, classifier: JSON.parse(await read('classifier.json')),
    log: (await read('events.jsonl')).trimEnd().split('\n').map(JSON.parse) };
}

test('H prevention retains stable continuity and a not-applicable recovery', async t => {
  const { result, events } = await fixture(t, { arm: 'H' });
  assert.equal(result.workflow.deployment, 'PROMOTION_BLOCKED');
  assert.equal(result.workflow.prevention.status, 'successful_prevention');
  assert.equal(result.workflow.recovery.primary.status, 'not_applicable');
  assert.equal(result.validity.status, 'valid');
  assert.ok(result.nextArmAllowed);
  assert.ok(events.find(([name]) => name === 'clear_fault')[1] >= events.find(([name]) => name === 'driver_finished')[1]);
});

test('C alert uses the third source completion and both origins, then waits ten seconds', async t => {
  const { result, log, classifier } = await fixture(t);
  const { workflow, preparation } = result;
  assert.equal(workflow.deployment, 'SWITCHED');
  assert.equal(workflow.recovery.primary.status, 'recovered_in_window');
  assert.equal(workflow.alert.source_sample_ids.length, 3);
  const third = log.find(entry => entry.id === workflow.alert.source_sample_id);
  assert.equal(workflow.alert.host_monotonic_ns, third.host_monotonic_ns);
  assert.equal(workflow.alert_to_restore.elapsed_ns, '10000000000');
  assert.equal(workflow.primary_deployment_to_alert.start_event_id, result.origin.id);
  assert.equal(workflow.fault_ack_to_alert.start_event_id, preparation.acknowledgment.id);
  assert.equal(BigInt(workflow.fault_ack_to_alert.elapsed_ns),
    BigInt(preparation.acknowledgment_to_deployment.elapsed_ns) + BigInt(workflow.primary_deployment_to_alert.elapsed_ns));
  assert.equal(result.observer.stable_verification.role, 'external_verification');
  assert.equal(classifier.result.accounting.offered.length, 300);
});

test('independent confirmation retains three source times and flags a preparation tolerance breach', async t => {
  const { result, log } = await fixture(t, { preparationDelay: 6 });
  const probes = result.preparation.confirmation.source_sample_ids.map(id => log.find(entry => entry.id === id));
  assert.deepEqual(probes.map(probe => [probe.path, probe.observation.http_status]), [
    ['/api/work', 500], ['/health', 200], ['/ready', 200]
  ]);
  assert.equal(probes[0].observation.version, '2.0.0');
  assert.equal(result.preparation.confirmation.host_monotonic_ns, probes[2].host_monotonic_ns);
  assert.equal(result.preparation.confirmation_to_deployment.elapsed_ns, '6000000000');
  assert.equal(result.preparation.tolerance_breached, true);
  assert.equal(result.validity.status, 'needs_review');
  assert.equal(result.workflow.deployment, 'SWITCHED');
});

test('unexpected H promotion starts the monitor and attributes recovery to occurrence time', async t => {
  const { result, events } = await fixture(t, { arm: 'H', deployment: 'PROMOTED' });
  assert.ok(events.some(([name]) => name === 'monitor'));
  assert.equal(result.workflow.restore.role, 'normal_workflow_restore');
  const [receipt] = result.workflow.monitor_timings;
  assert.equal(result.workflow.restore.host_monotonic_ns, receipt.marker.occurred_monotonic_ns);
  assert.notEqual(result.workflow.restore.host_monotonic_ns, receipt.host_monotonic_ns);
  assert.equal(result.workflow.recovery.primary.status, 'recovered_in_window');
  assert.equal(result.workflow.monitor_reports[0].outcome.status, 'ROLLED_BACK');
  assert.notEqual(result.workflow.prevention.status, 'successful_prevention');
});

test('H promotion failure retains transient exposure and unknown recovery attribution', async t => {
  const { result } = await fixture(t, { arm: 'H', deployment: 'PROMOTION_FAILED', transientExposure: true });
  assert.equal(result.workflow.deployment, 'PROMOTION_FAILED');
  assert.ok(result.workflow.public_candidate_request_ids.length > 0);
  assert.equal(result.workflow.recovery.primary.status, 'insufficient_evidence');
  assert.ok(result.nextArmAllowed);
});

test('parseable C refusal is measured through cutoff without an alert or restore', async t => {
  const { result } = await fixture(t, { deployment: 'FAILED' });
  assert.equal(result.workflow.deployment, 'FAILED');
  assert.equal(result.workflow.alert, null);
  assert.equal(result.workflow.recovery.primary.status, 'not_applicable');
  assert.equal(result.observer.primary_covered, true);
  assert.equal(result.validity.status, 'valid');
});

test('nonqualifying probes break the C alert streak and complete evidence supports non-recovery', async t => {
  const { result } = await fixture(t, { noAlert: true });
  assert.equal(result.workflow.alert, null);
  assert.equal(result.workflow.recovery.primary.status, 'no_in_window_recovery');
  assert.equal(result.validity.status, 'valid');
});

test('misses or lost observation distinguish incomplete evidence from definitive non-recovery', async t => {
  for (const options of [{ miss: true }, { observerFails: true }, { duration: 40 }]) {
    const { result, classifier } = await fixture(t, { noAlert: true, ...options });
    assert.equal(result.workflow.recovery.primary.status, 'insufficient_evidence');
    if (options.miss) assert.equal(classifier.result.accounting.counts.missed, 1);
    if (options.duration) assert.equal(result.metrics.client_coverage.primary_covered, false);
  }
});

test('parseable workflow restore failure remains adverse and later cleanup receives no recovery credit', async t => {
  const { result } = await fixture(t, { restoreFails: true });
  assert.equal(result.workflow.restore_outcome.outcome.status, 'FAILED');
  assert.equal(result.workflow.recovery.primary.status, 'no_in_window_recovery');
  assert.equal(result.workflow.recovery.late.status, 'late_recovery_not_observed_during_available_followup');
  assert.equal(result.validity.status, 'valid');
  assert.ok(result.nextArmAllowed);
});

test('post-cutoff alert and restore retain late recovery separately', async t => {
  const { result } = await fixture(t, { lateAlert: 59 });
  assert.equal(result.workflow.alert.post_cutoff_action, true);
  assert.equal(result.workflow.restore.post_cutoff_action, true);
  assert.equal(result.workflow.primary_deployment_to_alert, null);
  assert.equal(result.workflow.recovery.primary.status, 'no_in_window_recovery');
  assert.equal(result.workflow.recovery.late.status, 'late_recovery_observed');
});

test('missing startup or lost horizon prevents deployment, and final bracket mismatch is invalid', async t => {
  for (const options of [{ noNotification: true }, { preparationDelay: 65 }]) {
    const { result, events } = await fixture(t, options);
    assert.equal(result.workflow.deployment, 'NOT_INVOKED');
    assert.equal(result.validity.status, 'invalid');
    assert.ok(!events.some(([name]) => name === 'deploy'));
  }
  const { result } = await fixture(t, { badBracket: true });
  assert.equal(result.metrics.client_coverage.clock_matches, false);
  assert.equal(result.validity.status, 'invalid');
});

test('bad direct fault evidence or a failed write prevents deployment', async t => {
  for (const options of [{ badConfirmation: true }, { badProbeClock: true }, { writeFails: true }]) {
    const { result } = await fixture(t, options);
    assert.equal(result.workflow.deployment, 'NOT_INVOKED');
    assert.equal(result.preparation.status, options.writeFails ? 'write_failed' : 'confirmation_failed');
    assert.equal(result.validity.status, 'invalid');
    assert.ok(result.nextArmAllowed);
  }
});

test('uncertain fault-write acknowledgement inspects the actual flag and blocks unsafe clearance', async t => {
  const { result, log, events, read } = await fixture(t, { writeTimeout: true });
  assert.equal(result.preparation.status, 'write_ack_uncertain');
  assert.equal(result.workflow.deployment, 'NOT_INVOKED');
  assert.equal(log.find(event => event.event === 'candidate_fault_state_before_cleanup').state.present, true);
  assert.ok(!events.some(([name]) => name === 'clear_fault'));
  assert.equal(await read('fault-write.stdout.log'), 'partial fault evidence');
  assert.equal(result.nextArmAllowed, false);
});

test('deployment and operator restore timeouts preserve evidence and block cleanup', async t => {
  for (const options of [{ deployTimeout: true }, { restoreTimeout: true }, { malformedDeployment: true }]) {
    const { result, events } = await fixture(t, options);
    assert.equal(result.nextArmAllowed, false);
    assert.equal(result.metrics.client_coverage.primary_covered, true);
    assert.ok(!events.some(([name]) => name === 'clear_fault'));
    if (options.deployTimeout) assert.equal(result.execution.deployment.execution.timed_out, true);
    if (options.restoreTimeout) {
      assert.equal(result.workflow.restore_outcome.execution.timed_out, true);
      assert.equal(result.workflow.restore_outcome.outcome, null);
    }
  }
});

test('an unsettled monitor blocks cleanup and post-window fault clearance failure preserves recovery', async t => {
  const stalled = await fixture(t, { arm: 'H', deployment: 'PROMOTED', hungMonitor: true });
  assert.equal(stalled.result.execution.operations_settled, false);
  assert.equal(stalled.result.nextArmAllowed, false);
  assert.ok(!stalled.events.some(([name]) => name === 'clear_fault'));
  const failed = await fixture(t, { cleanupFails: true });
  assert.equal(failed.result.workflow.recovery.primary.status, 'recovered_in_window');
  assert.equal(failed.result.nextArmAllowed, false);
  assert.equal(failed.result.validity.status, 'valid');
});


test('an admitted alert near the horizon settles its operator wait after Driver finalization', async t => {
  const { result, events } = await fixture(t, { lateAlert: 110 });
  assert.ok(result.workflow.alert);
  assert.equal(result.workflow.alert_to_restore.elapsed_ns, '10000000000');
  assert.ok(events.find(([name]) => name === 'restore')[1] > events.find(([name]) => name === 'driver_finished')[1]);
  assert.ok(events.find(([name]) => name === 'clear_fault')[1] >= events.find(([name]) => name === 'restore')[1]);
  assert.equal(result.execution.operations_settled, true);
  assert.equal(result.nextArmAllowed, true);
});
