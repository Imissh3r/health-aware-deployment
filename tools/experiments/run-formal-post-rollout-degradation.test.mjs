import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFormalFaultyCandidate } from './run-formal-faulty-candidate.mjs';
import { runFormalPostRolloutDegradation } from './run-formal-post-rollout-degradation.mjs';

const second = 1_000_000_000n;
const ms = 1_000_000n;
const base = 8_000n * second;
const stable = { http_status: 200, version: '1.0.0' };
const healthy = { http_status: 200, version: '2.0.0' };
const degraded = { http_status: 500, version: '2.0.0' };
const clear = { deployment_id: null, pending_deployment_id: null };
const owned = { ...clear, deployment_id: 'test-deployment' };
const frozen = { project: 's3-fixture', proxyUrl: 'http://127.0.0.1:18080/api/work',
  stableConfigSha256: '0'.repeat(64), environmentFingerprint: 's3-fixture' };
const eventTime = event => BigInt(event.host_monotonic_ns);

async function fixture(t, options = {}) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'formal-s3-'));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const arm = options.arm ?? 'H';
  const start = base + second;
  const duration = options.duration ?? 120;
  const end = start + BigInt(duration) * second;
  const clock = { version: 1, source: 'process.hrtime.bigint',
    start_before_ns: String(start), start_after_ns: String(start) };
  let now = base;
  let state = clear;
  let flag = false;
  let canceled = false;
  let deployed;
  let injected;
  let restored;
  let ack;
  let monitorPublish;
  let monitorDone;
  let inProgress = false;
  let monitorExited = false;
  let restoreCalls = 0;
  let flagObservationSkipped = false;
  const driverDone = Promise.withResolvers();
  const events = [];
  const timers = [];
  const add = (at, fn) => timers.push({ at, fn });
  const note = (name, at = now) => events.push([name, at]);

  function restoreEffect(at) {
    restored = at;
    add(at, () => { state = clear; note('stable_restored'); });
  }

  function scheduleH() {
    const detectionAt = options.preWriteDetection ? injected - 20n * ms
      : options.bracketDetection ? injected + 50n * ms : ack + 3n * second;
    const finish = options.hungMonitor ? null : options.pendingAtFinalize ? end + 2n * second
      : options.boundary !== undefined ? ack + 60n * second - 600n * ms : detectionAt + second;
    const marker = (event, at) => monitorPublish({ type: 'timing', value: {
      event, deployment_id: owned.deployment_id, occurred_monotonic_ns: String(at),
      source_observations: [{ sequence: 3, observation_id: 'probe-3' }]
    } });
    add(detectionAt, () => {
      inProgress = true;
      note('locked_confirmation', detectionAt);
      if (!options.missingMarkers) add(detectionAt + 10n * ms, () => {
        marker('third_qualifying_failure', detectionAt - ms);
        marker('locked_degradation_confirmed', detectionAt);
      });
      note('rollback_begins');
      if (finish === null) return;
      restoreEffect(finish);
      add(finish, () => {
        monitorPublish({ type: 'report', value: { status: 'ROLLED_BACK' } });
        monitorPublish({ type: 'status', value: { status: 'ROLLED_BACK' } });
        monitorDone.resolve({ exitCode: 0 });
        monitorExited = true;
        inProgress = false;
      });
    });
  }

  const ops = {
    now: () => now,
    waitUntil(at, signal) {
      if (at <= now || signal?.aborted) return Promise.resolve();
      return new Promise(resolve => {
        const done = () => { signal?.removeEventListener('abort', done); resolve(); };
        signal?.addEventListener('abort', done, { once: true });
        add(at, () => { if (!signal?.aborted) done(); });
      });
    },
    async preflight() { return { stable: true }; },
    routingState: () => state,
    driverRunning: () => !canceled && now < end,
    startDriver(args, receive) {
      const arg = name => args[args.indexOf('--' + name) + 1];
      assert.ok(args.includes('--notify-start'));
      assert.deepEqual(['rate', 'duration', 'warmup', 'timeout', 'max-concurrency', 'max-lateness'].map(arg),
        ['5', '120', '5', '3000', '50', '200']);
      if (!options.missingStartup) add(start + 20n, () => receive({
        event: 'driver_start', run_id: arg('run-id'), clock_alignment: clock
      }));
      add(end, () => {
        if (canceled) return;
        note('driver_finish');
        const runId = arg('run-id');
        const directory = join(arg('out'), runId);
        mkdirSync(directory);
        writeFileSync(join(directory, 'run.json'), JSON.stringify({
          run_id: runId, status: duration === 120 ? 'complete' : 'incomplete', target_url: frozen.proxyUrl,
          options: { rate: 5, duration_seconds: 120, warmup_seconds: 5, timeout_ms: 3000, max_concurrency: 50, max_lateness_ms: 200 },
          clock_alignment: { ...clock, ...(options.badBracket && { start_before_ns: String(start - 1n) }),
            end_before_ns: String(end), end_after_ns: String(end), elapsed_ns: String(end - start) }
        }));
        const columns = 'run_id,seq,scheduled_ms,dispatched_ms,completed_ms,dispatch_delay_ms,latency_ms,outcome,http_status,error_code,miss_reason,version,warmup';
        const rows = Array.from({ length: duration * 5 }, (_, index) => {
          const offset = index * 200;
          const at = start + BigInt(offset) * ms;
          const candidate = deployed && at >= deployed && (!restored || at < restored);
          const failed = Boolean(candidate && injected && at >= injected);
          let completed = offset + 10;
          if (options.boundary !== undefined && at === ack + 60n * second - 200n * ms) {
            completed = Number((ack + 60n * second - start) / ms) + options.boundary;
          }
          return [runId, index + 1, offset, offset, completed, 0, completed - offset, failed ? 'http_error' : 'ok',
            failed ? 500 : 200, '', '', candidate ? '2.0.0' : '1.0.0', offset < 5000].join(',');
        });
        writeFileSync(join(directory, 'requests.csv'), [columns, ...rows].join('\n') + '\n');
        driverDone.resolve({ exitCode: duration === 120 ? 0 : 1 });
      });
      return { finished: driverDone.promise, stop() { canceled = true; driverDone.resolve({ signal: 'SIGTERM' }); } };
    },
    async deploy() {
      note('deploy');
      const status = options.deploymentFailure ? (arm === 'H' ? 'PROMOTION_FAILED' : 'FAILED')
        : arm === 'H' ? 'PROMOTED' : 'SWITCHED';
      if (!options.deploymentFailure) {
        deployed = now;
        state = owned;
      }
      if (options.missingDeploymentOutcome !== undefined) {
        return { exitCode: 1, stdout: options.missingDeploymentOutcome, stderr: 'controller evidence' };
      }
      return { exitCode: options.deploymentFailure ? 1 : 0, stdout: JSON.stringify({
        event: arm === 'H' ? 'candidate_promotion' : 'conventional_release', action: 'switch',
        deployment_id: owned.deployment_id, status
      }) };
    },
    async observe() {
      note('probe');
      if (options.observerFails && deployed && !flag) throw new Error('observer unavailable');
      if (options.delayedVerification && !flag && deployed && now < deployed + 50n * second) return stable;
      if (state !== owned) return stable;
      if (!flag) return healthy;
      if (options.noAlert && (now - deployed) % (3n * second) === 0n) return stable;
      if (options.alertAt && now < (options.alertAt === 'near_end' ? end - 4n * second : ack + 59n * second)) return stable;
      return degraded;
    },
    async faultState() {
      if (options.loseHorizonDuringCheck && state === owned && !flag) now += 55n * second;
      if (options.unverifiedFlagObservation && flag && !flagObservationSkipped) {
        flagObservationSkipped = true;
        return { present: null };
      }
      return { present: flag };
    },
    async writeFault(onInvoke) {
      onInvoke();
      injected = now;
      ack = now;
      flag = true;
      return { exitCode: 0 };
    },
    async candidateProbe(path) {
      now += ms;
      return { http_status: path === '/api/work' ? 500 : 200, version: '2.0.0',
        completed_monotonic_ns: String(now) };
    },
    async writePostRolloutFault(_owner, onInvoke) {
      const reason = onInvoke();
      if (reason) return { refused: true, reason };
      note('fault_command');
      const done = Promise.withResolvers();
      injected = now + 100n * ms;
      ack = start + (options.boundary === undefined ? (arm === 'C' ? 13_050n : 15_050n) : 15_000n) * ms;
      if (!options.faultFailed) add(injected, () => { flag = true; note('fault_written'); });
      if (arm === 'H' && !options.faultFailed && !options.faultTimeout) scheduleH();
      add(ack, () => {
        note('fault_return');
        done.resolve({ exitCode: options.faultFailed ? 1 : options.faultTimeout ? null : 0,
          timedOut: options.faultTimeout === true, signal: options.faultTimeout ? 'SIGTERM' : null,
          writeStartedNs: String(injected), stdout: 'fault output' });
      });
      return done.promise;
    },
    startMonitor(_owner, _horizon, publish) {
      note('monitor_started');
      monitorPublish = publish;
      monitorDone = Promise.withResolvers();
      return { finished: monitorDone.promise, stop() {
        note('monitor_admission_closed');
        if (!inProgress && !monitorExited) {
          publish({ type: 'status', value: { status: 'ADMISSION_CLOSED' } });
          monitorDone.resolve({ exitCode: 0 });
        }
      } };
    },
    async restore(_arm, _owner, capture, onInvoke) {
      onInvoke?.();
      note(onInvoke ? 'workflow_restore' : 'cleanup_restore');
      const failed = options.restoreFails && restoreCalls++ === 0;
      const status = failed ? 'FAILED' : 'RESTORED';
      if (_arm === 'C') capture({ exitCode: failed ? 1 : 0, stdout: JSON.stringify({
        event: 'conventional_release', action: 'restore', deployment_id: owned.deployment_id, status
      }) });
      if (failed) throw new Error('restore failed');
      state = clear;
      restored ??= now;
      return { status };
    },
    async verifyStableForFaultClear() { assert.equal(state, clear); },
    async clearFault() {
      note('clear_fault');
      if (options.cleanupFails) return { exitCode: 1 };
      flag = false;
      return { exitCode: 0 };
    },
    async reset() {
      assert.equal(flag, false);
      assert.equal(state, clear);
      if (options.resetFails) throw new Error('reset could not establish stable baseline');
    }
  };
  if (options.foreign) add(start + 35n * second, () => { state = { ...owned, deployment_id: 'foreign' }; });
  const runner = options.s2 ? runFormalFaultyCandidate : runFormalPostRolloutDegradation;
  const run = runner({ arm, trialId: 'fixture', evidenceRoot, frozen }, ops);
  let done = false;
  run.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; !done && i < 500; i++) {
    await new Promise(resolve => setImmediate(resolve));
    if (done) break;
    timers.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    const next = timers.shift();
    assert.ok(next, 'No event can advance the fixture');
    if (now < next.at) now = next.at;
    next.fn();
  }
  assert.ok(done, 'Fixture did not settle');
  const summary = await run;
  const read = name => readFile(join(summary.directory, name), 'utf8');
  return { summary, events, read, log: (await read('events.jsonl')).trimEnd().split('\n').map(JSON.parse),
    classifier: JSON.parse(await read('classifier.json')) };
}

test('H verifies the candidate, settles for five seconds, and attributes recovery to the locked hook', async t => {
  const { summary, events, log, classifier } = await fixture(t);
  assert.equal(summary.validity.status, 'valid');
  assert.equal(summary.stage, 'FAULT_ACKNOWLEDGED');
  assert.equal(summary.preparation.status, 'active_verified');
  assert.equal(summary.preparation.active_flag_observation.state.present, true);
  assert.ok(!Object.hasOwn(summary.preparation, 'acknowledgment_to_deployment'));
  assert.deepEqual(summary.preparation.deployment_to_acknowledgment, {
    start_event_id: summary.deployment_invocation.id, end_event_id: summary.origin.id,
    elapsed_ns: String(eventTime(summary.origin) - eventTime(summary.deployment_invocation))
  });
  assert.ok(BigInt(summary.preparation.deployment_to_acknowledgment.elapsed_ns) > 0n);
  assert.equal(summary.candidate_verified.source_sample_ids.length, 3);
  assert.equal(eventTime(summary.preparation.invocation) - eventTime(summary.candidate_verified), 5n * second);
  assert.equal(summary.origin.id, summary.preparation.acknowledgment.id);
  assert.equal(BigInt(summary.origin.cutoff_ns) - eventTime(summary.origin), 60n * second);
  assert.ok(eventTime(summary.preparation.invocation) < eventTime(summary.fault_write_started));
  assert.ok(eventTime(summary.fault_write_started) < eventTime(summary.origin));
  assert.equal(summary.workflow.detection.latency_ns, String(3n * second));
  assert.equal(summary.workflow.third_failure.source_observations[0].observation_id, 'probe-3');
  const lock = summary.workflow.locked_confirmation;
  assert.ok(eventTime(lock) <= events.find(([name]) => name === 'rollback_begins')[1]);
  const receipt = log.find(event => event.id === lock.source_event_id);
  assert.equal(receipt.marker.occurred_monotonic_ns, lock.host_monotonic_ns);
  assert.ok(eventTime(receipt) > eventTime(lock));
  assert.equal(summary.workflow.recovery.primary.status, 'recovered_in_window');
  assert.equal(classifier.result.candidate.primary.status, 'observed');
  assert.equal(Object.keys(summary.metrics.approved_measures).length, 6);
  assert.ok(summary.nextArmAllowed);
});

test('C uses the third candidate 500 completion and the ten-second operator delay', async t => {
  const { summary, log } = await fixture(t, { arm: 'C' });
  const { alert, detection, alert_to_restore, recovery } = summary.workflow;
  assert.equal(summary.preparation.status, 'active_verified');
  assert.equal(summary.preparation.active_flag_observation.state.present, true);
  assert.ok(!Object.hasOwn(summary.workflow, 'primary_deployment_to_alert'));
  assert.ok(!Object.hasOwn(summary.preparation, 'acknowledgment_to_deployment'));
  assert.deepEqual(summary.workflow.deployment_to_alert, {
    start_event_id: summary.deployment_invocation.id, end_event_id: alert.id,
    elapsed_ns: String(eventTime(alert) - eventTime(summary.deployment_invocation))
  });
  assert.deepEqual(summary.workflow.fault_ack_to_alert, {
    start_event_id: summary.origin.id, end_event_id: alert.id, elapsed_ns: detection.latency_ns
  });
  assert.ok(BigInt(summary.workflow.deployment_to_alert.elapsed_ns) > BigInt(summary.workflow.fault_ack_to_alert.elapsed_ns));
  assert.equal(alert.source_sample_ids.length, 3);
  assert.equal(alert.role, 'decision_alert');
  assert.equal(eventTime(alert), eventTime(log.find(event => event.id === alert.source_sample_ids[2])));
  assert.equal(detection.status, 'observed');
  assert.equal(alert_to_restore.elapsed_ns, String(10n * second));
  assert.equal(recovery.primary.status, 'recovered_in_window');
  assert.equal(summary.observer.stable_verification.role, 'external_verification');
});

test('pre-fault deployment failure and workflow time-budget exhaustion are retained outcomes', async t => {
  for (const [options, reason] of [[{ deploymentFailure: true }, 'deployment_failure'],
    [{ arm: 'C', delayedVerification: true }, 'workflow_time_budget_exceeded']]) {
    const { summary, events } = await fixture(t, options);
    assert.equal(summary.stage, 'STAGE_NOT_REACHED');
    assert.equal(summary.fault_stage_reason, reason);
    assert.equal(summary.validity.status, 'valid');
    assert.equal(summary.workflow.recovery.primary.status, 'not_applicable');
    assert.ok(!events.some(([name]) => name === 'fault_command'));
  }
});

test('startup, driver coverage loss, and observer failure remain distinct from workflow budget exhaustion', async t => {
  for (const [options, reason] of [[{ missingStartup: true }, 'measurement_coverage_failure'],
    [{ duration: 10 }, 'measurement_coverage_failure'],
    [{ arm: 'C', loseHorizonDuringCheck: true }, 'measurement_coverage_failure'],
    [{ observerFails: true }, 'observer_coverage_failure']]) {
    const { summary, events } = await fixture(t, options);
    assert.equal(summary.fault_stage_reason, reason);
    assert.ok(!events.some(([name]) => name === 'fault_command'));
  }
  const { summary } = await fixture(t, { badBracket: true });
  assert.equal(summary.metrics.client_coverage.clock_matches, false);
  assert.equal(summary.validity.status, 'invalid');
});

test('failed and timed-out writes retain raw output and never establish a recovery origin', async t => {
  for (const options of [{ faultFailed: true }, { faultTimeout: true }]) {
    const { summary, log, read } = await fixture(t, options);
    assert.equal(summary.origin, undefined);
    assert.equal(summary.fault_stage_reason, 'fault_acknowledgment_unverified');
    assert.equal(summary.preparation.status, options.faultTimeout ? 'write_ack_uncertain' : 'write_failed');
    assert.equal(await read('fault-write.stdout.log'), 'fault output');
    if (options.faultTimeout) {
      assert.equal(log.find(event => event.event === 'candidate_fault_state_before_cleanup').state.present, true);
      assert.equal(summary.nextArmAllowed, false);
    }
  }
});

test('H confirmation during the write bracket preserves signed times and independent client recovery', async t => {
  const { summary } = await fixture(t, { bracketDetection: true });
  const detection = summary.workflow.detection;
  assert.equal(detection.status, 'origin_uncertain');
  assert.ok(BigInt(detection.from_acknowledgment_ns) < 0n);
  assert.ok(BigInt(detection.from_write_start_ns) > 0n);
  assert.equal(detection.latency_ns, undefined);
  assert.equal(summary.workflow.recovery.primary.status, 'recovered_in_window');
});

test('confirmation before write start and missing hook delivery cannot establish an attributed recovery', async t => {
  const early = await fixture(t, { preWriteDetection: true });
  assert.equal(early.summary.workflow.detection.status, 'attribution_review');
  assert.equal(early.summary.workflow.restore, null);
  assert.equal(early.summary.workflow.recovery.primary.status, 'insufficient_evidence');
  assert.equal(early.summary.metrics.request_accounting, 'complete');
  const missing = await fixture(t, { missingMarkers: true });
  assert.equal(missing.summary.workflow.detection.status, 'insufficient_evidence');
  assert.ok(missing.summary.validity.issues.includes('monitor_timing_missing'));
  assert.equal(missing.summary.workflow.recovery.primary.status, 'insufficient_evidence');
});

test('no alert and failed restore are measured negatives when coverage is complete', async t => {
  for (const options of [{ noAlert: true }, { restoreFails: true }]) {
    const { summary } = await fixture(t, { arm: 'C', ...options });
    assert.equal(summary.workflow.recovery.primary.status, 'no_in_window_recovery');
    assert.equal(summary.validity.status, 'valid');
    assert.ok(summary.nextArmAllowed);
  }
  const { summary } = await fixture(t, { arm: 'C', noAlert: true, duration: 45 });
  assert.equal(summary.workflow.recovery.primary.status, 'insufficient_evidence');
  assert.equal(summary.metrics.client_coverage.primary_covered, false);
});

for (const offset of [-1, 0, 1]) {
  test('client cutoff is exclusive for certification offset ' + offset + ' ms', async t => {
    const { summary } = await fixture(t, { boundary: offset });
    assert.equal(summary.workflow.recovery.primary.status, offset < 0 ? 'recovered_in_window' : 'no_in_window_recovery');
    assert.equal(summary.workflow.recovery.late.status, offset < 0 ? 'not_applicable' : 'late_recovery_observed');
    const milestone = offset < 0 ? summary.workflow.recovery.primary.milestone : summary.workflow.recovery.late.milestone;
    assert.equal(BigInt(milestone.certification[0]) - BigInt(summary.origin.cutoff_ns), BigInt(offset) * ms);
  });
}

test('post-cutoff C actions remain late and an admitted operator wait can outlive Driver finalization', async t => {
  for (const alertAt of ['late', 'near_end']) {
    const { summary, events } = await fixture(t, { arm: 'C', alertAt });
    assert.equal(summary.workflow.alert.post_cutoff_action, true);
    assert.equal(summary.workflow.restore.post_cutoff_action, true);
    assert.equal(summary.workflow.detection.status, 'post_cutoff_action');
    assert.equal(summary.workflow.recovery.primary.status, 'no_in_window_recovery');
    if (alertAt === 'near_end') assert.ok(events.find(([name]) => name === 'workflow_restore')[1] >
      events.find(([name]) => name === 'driver_finish')[1]);
    else assert.equal(summary.workflow.recovery.late.status, 'late_recovery_observed');
    assert.ok(summary.execution.operations_settled);
  }
});

test('settlement preserves in-progress H rollback and blocks a stalled monitor', async t => {
  const settled = await fixture(t, { pendingAtFinalize: true });
  assert.equal(settled.summary.execution.operations_settled, true);
  const when = name => settled.events.find(([event]) => event === name)[1];
  assert.ok(when('stable_restored') > when('driver_finish'));
  assert.ok(when('clear_fault') >= when('stable_restored'));
  const stalled = await fixture(t, { hungMonitor: true });
  assert.equal(stalled.summary.execution.operations_settled, false);
  assert.equal(stalled.summary.nextArmAllowed, false);
  assert.ok(!stalled.events.some(([name]) => name === 'clear_fault'));
});

test('foreign ownership, fault-clear failure and reset failure block continuation without erasing evidence', async t => {
  for (const options of [{ arm: 'C', noAlert: true, foreign: true }, { cleanupFails: true }, { resetFails: true }]) {
    const { summary, classifier } = await fixture(t, options);
    assert.equal(summary.nextArmAllowed, false);
    assert.equal(classifier.result.accounting.completeness, 'complete');
    if (!options.foreign) assert.equal(summary.workflow.recovery.primary.status, 'recovered_in_window');
    if (options.resetFails) assert.equal(summary.reset.status, 'failed');
  }
});


test('invoked S3 deployment with missing or malformed output retains uncertainty and blocks cleanup', async t => {
  for (const missingDeploymentOutcome of ['', '{']) {
    const { summary, events, read } = await fixture(t, { arm: 'C', missingDeploymentOutcome });
    assert.equal(summary.workflow.deployment, 'UNKNOWN');
    assert.equal(summary.fault_stage_reason, 'deployment_evidence_missing');
    assert.equal(summary.preparation.status, 'stage_not_reached');
    assert.equal(summary.execution.deployment.outcome, null);
    assert.equal(summary.deployment_invocation.event, 'deployment_invoked');
    assert.equal(summary.nextArmAllowed, false);
    assert.equal(summary.cleanup.status, 'blocked_or_failed');
    assert.ok(!events.some(([name]) => name === 'fault_command' || name === 'cleanup_restore'));
    assert.equal(await read('deployment.stdout.log'), missingDeploymentOutcome);
  }
  const { summary } = await fixture(t, { missingStartup: true });
  assert.equal(summary.workflow.deployment, 'NOT_INVOKED');
});

test('S2 keeps predeployment confirmation and deployment-origin primary alert fields', async t => {
  const { summary } = await fixture(t, { arm: 'C', s2: true });
  const { preparation, workflow } = summary;
  assert.equal(preparation.status, 'confirmed');
  assert.ok(!Object.hasOwn(preparation, 'deployment_to_acknowledgment'));
  assert.deepEqual(preparation.acknowledgment_to_deployment, {
    start_event_id: preparation.acknowledgment.id, end_event_id: summary.origin.id,
    elapsed_ns: String(eventTime(summary.origin) - eventTime(preparation.acknowledgment))
  });
  assert.deepEqual(workflow.primary_deployment_to_alert, workflow.deployment_to_alert);
  assert.equal(workflow.primary_deployment_to_alert.start_event_id, summary.origin.id);
  assert.equal(workflow.fault_ack_to_alert.start_event_id, preparation.acknowledgment.id);
});


test('S3 preserves acknowledgment separately when active flag observation is unavailable', async t => {
  const { summary } = await fixture(t, { unverifiedFlagObservation: true });
  assert.equal(summary.stage, 'FAULT_ACKNOWLEDGED');
  assert.equal(summary.preparation.status, 'acknowledged_state_unverified');
  assert.equal(summary.preparation.acknowledgment.id, summary.origin.id);
  assert.equal(summary.preparation.active_flag_observation.state.present, null);
});
