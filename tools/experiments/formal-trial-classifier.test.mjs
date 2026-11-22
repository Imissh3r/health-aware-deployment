import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTrialEvidence } from './formal-trial-classifier.mjs';

const start = 1_795_167_069_023;
const cutoff = start + 60_000;
const deploymentId = 'deployment-calibration';
const trialId = 'candidate-trial';
const cleanup = cutoff + 1500;

function event(name, wall_ms) {
  return { trial_id: trialId, arm: 'B', event: name, wall_ms, source: 'runner' };
}

function clockSamples(interval = 250) {
  const samples = [];
  for (let elapsed = 0; elapsed <= cleanup - start + interval; elapsed += interval) {
    samples.push({ wall_ms: start + elapsed, monotonic_ms: 1000 + elapsed });
  }
  return samples;
}

function attachProbe(input, { begin = 0, complete = 200, status = 500, version = '2.0.0', error = null } = {}) {
  const observation = input.trial.observation;
  observation.final_observation = {
    started_at_ms: cutoff + begin,
    completed_at_ms: cutoff + complete,
    http_status: status,
    version,
    error
  };
  observation.final_observation_lateness_ms = begin;
  observation.final_observation_skip_reason = null;
}

function fixture({ offset = 59_999, terminal = 'ROLLED_BACK' } = {}) {
  const verified = terminal === 'ROLLED_BACK' || terminal === 'FINALIZATION_FAILED';
  const verifiedAt = verified ? start + offset : null;
  const recovery = verified ? {
    proxy_verified: true,
    verified_at: new Date(verifiedAt).toISOString(),
    verification: { passed: true, consecutive: 3 },
    last_proxy_observation: { http_status: 200, version: '1.0.0' }
  } : { proxy_verified: false, failed_step: 'RECOVERY_VERIFICATION', reason: 'Fixture verification timed out' };
  if (terminal === 'FINALIZATION_FAILED') recovery.failed_step = 'CLEAR_ACTIVE_DEPLOYMENT';
  const controller = [
    { deployment_id: deploymentId, status: 'OPERATOR_DELAY_STARTED' },
    { deployment_id: deploymentId, status: terminal, recovery }
  ];
  const trial = {
    trial_id: trialId, deployment_id: deploymentId, arm: 'B', event: 'paired_pilot', preflight_only: false,
    status: terminal === 'ROLLED_BACK' && offset < 60_000 ? 'TRIAL_PASSED' : 'TRIAL_FAILED',
    checks: {
      routing_state: { deployment_id: null, pending_deployment_id: null },
      config_upstreams: ['http://app:3000'],
      services: {
        db: [{ state: 'running', health: 'healthy' }],
        app: [{ state: 'running', health: 'healthy' }],
        candidate: [{ state: 'running', health: 'healthy' }],
        nginx: [{ state: 'running', health: null }]
      },
      candidate_fault_flag: 'absent',
      proxy: { http_status: 200, version: '1.0.0' }
    },
    monitor_process: { exit_code: terminal === 'ROLLED_BACK' ? 0 : 1, signal: null, exited_at_ms: cutoff + 1000 },
    failures: terminal === 'ROLLED_BACK' && offset < 60_000 ? [] : [{ step: 'timeline', reason: 'Fixture' }],
    observation: {
      cutoff_ms: cutoff,
      cleanup_started_ms: cleanup,
      runner_cleanup_deferred_through_cutoff: true,
      final_observation: null,
      final_observation_lateness_ms: null,
      final_observation_skip_reason: verified && offset < 60_000 ? 'verified_in_window' : null,
      fault_flag_present_at_cleanup: true,
      verified_at_ms: verifiedAt,
      recovery_verified_in_window: verified && offset < 60_000,
      terminal_rollback_failure: terminal === 'ROLLBACK_FAILED',
      interrupted_at_ms: null
    }
  };
  const driver = {
    run_id: trialId,
    status: 'complete',
    wall_start_ms: start,
    target_url: 'http://127.0.0.1:8080/api/work',
    review_required: false,
    options: {
      rate: 5, duration_seconds: 60, warmup_seconds: 5, timeout_ms: 3000,
      max_concurrency: 50, max_lateness_ms: 200
    },
    invariants: {
      offered_accounted: true, dispatched_settled: true, record_count_and_sequence: true,
      missed_reasons_accounted: true
    },
    summary: {
      offered: 300, dispatched: 300, settled: 300, missed: 0,
      missed_by_reason: { late: 0, concurrency: 0 },
      outcomes: { ok: 75, http_error: 225, timeout: 0, connection_error: 0, driver_error: 0, interrupted: 0, missed: 0 }
    }
  };
  const requests = Array.from({ length: 300 }, (_, index) => ({
    run_id: trialId, seq: index + 1, scheduled_ms: index * 200,
    completed_ms: index * 200 + 6, latency_ms: 5, outcome: index < 75 ? 'ok' : 'http_error',
    http_status: index < 75 ? 200 : 500, miss_reason: null, version: '2.0.0'
  }));
  const events = [
    event('promotion_verified', start - 1000),
    event('driver_started', start),
    event('fault_activated', start + 15_010),
    ...(verified ? [event('recovery_verified', verifiedAt)] : []),
    event('fault_cleared', cleanup + 20)
  ];
  const input = { trial, driver, requests, events, controller, clockSamples: clockSamples() };
  if (!verified) attachProbe(input);
  return input;
}

for (const [name, config, expectedTiming] of [
  ['59,999 ms is in-window', { offset: 59_999 }, 'in_window'],
  ['60,000 ms is late', { offset: 60_000 }, 'late'],
  ['60,001 ms is late', { offset: 60_001 }, 'late'],
  ['verification survives failed finalization', { terminal: 'FINALIZATION_FAILED' }, 'in_window']
]) {
  test(name, () => {
    const input = fixture(config);
    const result = classifyTrialEvidence(input);
    const inWindow = expectedTiming === 'in_window';
    const code = inWindow ? 'VERIFIED_BEFORE_CUTOFF' : 'VERIFIED_AT_OR_AFTER_CUTOFF';
    assert.deepEqual(result.recoveryEvidence, {
      status: 'verified', reasonCodes: [code], verifiedAtMs: input.trial.observation.verified_at_ms, timing: expectedTiming
    });
    assert.deepEqual(result.cutoffOutcome, {
      status: inWindow ? 'recovered_in_window' : 'unknown', reasonCodes: [code]
    });
    assert.equal(result.probeUsability.status, 'not_collected');
    assert.equal(result.attemptValidity.status, 'valid');
  });
}

for (const [name, offset, response, flag, outcome] of [
  ['stable sample preserves late verification', 60_000, { status: 200, version: '1.0.0' },
    'PROBE_STABLE_AT_CUTOFF', 'unknown'],
  ['a later candidate 500 preserves earlier verification', 59_999, {}, 'POST_VERIFICATION_CANDIDATE_500',
    'recovered_in_window'],
  ['late verification with a candidate 500 stays unknown in the conservative rule', 60_001, {}, null, 'unknown']
]) {
  test(name, () => {
    const input = fixture({ offset });
    attachProbe(input, response);
    const result = classifyTrialEvidence(input);
    assert.equal(result.cutoffOutcome.status, outcome);
    assert.equal(result.recoveryEvidence.verifiedAtMs, start + offset);
    assert.deepEqual(result.reviewFlags, flag === null ? [] : [flag]);
  });
}

for (const [name, changes, expectedStatus, reason] of [
  ['completion at +200 ms is eligible', { complete: 200 }, 'not_recovered_by_cutoff', 'CANDIDATE_500_NEAR_CUTOFF'],
  ['completion at +201 ms is ineligible', { complete: 201 }, 'unknown', 'PROBE_OUTSIDE_WINDOW'],
  ['starting before cutoff is ineligible', { begin: -1 }, 'unknown', 'PROBE_OUTSIDE_WINDOW'],
  ['a failed probe is inconclusive', { status: null, version: null, error: 'Timeout' }, 'unknown', 'PROBE_FAILED'],
  ['a lone stable 200 is inconclusive', { status: 200, version: '1.0.0' }, 'unknown', 'NO_DECISIVE_CUTOFF_EVIDENCE'],
  ['503 does not meet the candidate failure signature', { status: 503, version: null }, 'unknown',
    'NO_DECISIVE_CUTOFF_EVIDENCE']
]) {
  test(name, () => {
    const input = fixture({ terminal: 'ROLLBACK_FAILED' });
    attachProbe(input, changes);
    const result = classifyTrialEvidence(input);
    assert.deepEqual(result.cutoffOutcome, { status: expectedStatus, reasonCodes: [reason] });
    assert.equal(result.attemptValidity.status, 'valid');
    assert.equal(result.workloadUsability.status, 'usable');
  });
}

test('probe completion can tie cleanup in a trusted runner record', () => {
  const input = fixture({ terminal: 'ROLLBACK_FAILED' });
  input.trial.observation.cleanup_started_ms = cutoff + 200;
  assert.equal(classifyTrialEvidence(input).cutoffOutcome.status, 'not_recovered_by_cutoff');
  input.trial.observation.cleanup_started_ms--;
  assert.deepEqual(classifyTrialEvidence(input).probeUsability, {
    status: 'unusable', reasonCodes: ['PROBE_OUTSIDE_WINDOW']
  });
});

test('an interruption during a probe preserves the usable workload and leaves cutoff unknown', () => {
  const input = fixture({ terminal: 'ROLLBACK_FAILED' });
  input.trial.observation.interrupted_at_ms = cutoff + 100;
  input.trial.failures.push({ step: 'interrupted', reason: 'Trial interrupted' });
  const result = classifyTrialEvidence(input);
  assert.deepEqual(result.cutoffOutcome, { status: 'unknown', reasonCodes: ['PROBE_INTERRUPTED'] });
  assert.equal(result.attemptValidity.status, 'valid');
  assert.equal(result.workloadUsability.status, 'usable');
});

for (const [name, patch] of [
  ['stop reason', { stop_reason: 'Process timed out' }],
  ['signal', { signal: 'SIGINT' }],
  ['spawn error', { error: 'spawn failed' }],
  ['stop request timestamp', { stop_requested_at_ms: cutoff }],
  ['wrong exit code', { exit_code: 2 }]
]) {
  test('rollback failure with ' + name + ' cannot establish non-recovery', () => {
    const input = fixture({ terminal: 'ROLLBACK_FAILED' });
    Object.assign(input.trial.monitor_process, patch);
    const result = classifyTrialEvidence(input);
    assert.deepEqual(result.cutoffOutcome, { status: 'unknown', reasonCodes: ['NO_DECISIVE_CUTOFF_EVIDENCE'] });
    assert.equal(result.recoveryEvidence.status, 'unverified');
    assert.equal(result.controllerStatus, 'ROLLBACK_FAILED');
  });
}

test('a documented stop before entering rollback remains diagnostic', () => {
  const input = fixture({ terminal: 'DELAYED_ROLLBACK_NOT_STARTED' });
  const result = classifyTrialEvidence(input);
  assert.deepEqual(result.cutoffOutcome, { status: 'unknown', reasonCodes: ['NO_DECISIVE_CUTOFF_EVIDENCE'] });
  assert.equal(result.controllerStatus, 'DELAYED_ROLLBACK_NOT_STARTED');
});

test('a rollback status without a usable failed step and reason does not qualify', () => {
  const input = fixture({ terminal: 'ROLLBACK_FAILED' });
  input.controller.at(-1).recovery.reason = ' ';
  assert.equal(classifyTrialEvidence(input).cutoffOutcome.status, 'unknown');
});

for (const [name, edit, status, reason] of [
  ['missing log', input => { input.controller = []; }, 'unverified', 'RECOVERY_EVIDENCE_MISSING'],
  ['missing verification timestamp', input => { delete input.controller.at(-1).recovery.verified_at; },
    'unverified', 'RECOVERY_EVIDENCE_MISSING'],
  ['malformed verification timestamp', input => { input.controller.at(-1).recovery.verified_at = 'invalid'; },
    'untrusted', 'RECOVERY_EVIDENCE_MALFORMED'],
  ['malformed controller record', input => { input.controller.push(null); },
    'untrusted', 'RECOVERY_EVIDENCE_MALFORMED'],
  ['missing row within a controller record', input => { input.controller.length++; },
    'untrusted', 'RECOVERY_EVIDENCE_MALFORMED'],
  ['mismatched deployment ID', input => { input.controller.at(-1).deployment_id = 'other-deployment'; },
    'untrusted', 'EVIDENCE_CONFLICT'],
  ['runner timestamp disagrees', input => { input.trial.observation.verified_at_ms++; },
    'untrusted', 'EVIDENCE_CONFLICT'],
  ['runner verification flag disagrees', input => { input.trial.observation.recovery_verified_in_window = false; },
    'untrusted', 'EVIDENCE_CONFLICT'],
  ['controller and events timestamps disagree', input => { input.events.find(row => row.event === 'recovery_verified').wall_ms++; },
    'untrusted', 'EVIDENCE_CONFLICT']
]) {
  test(name + ' leaves the cutoff unknown', () => {
    const input = fixture();
    edit(input);
    const result = classifyTrialEvidence(input);
    assert.deepEqual(result.cutoffOutcome, { status: 'unknown', reasonCodes: [reason] });
    assert.equal(result.recoveryEvidence.status, status);
    assert.equal(result.recoveryEvidence.timing, null);
    assert.equal(result.attemptValidity.status, 'valid');
    assert.equal(result.workloadUsability.status, 'usable');
  });
}

test('candidate 500 without a controller record cannot establish non-recovery', () => {
  const input = fixture({ terminal: 'ROLLBACK_FAILED' });
  input.controller = [];
  const result = classifyTrialEvidence(input);
  assert.equal(result.probeUsability.status, 'usable');
  assert.deepEqual(result.cutoffOutcome, { status: 'unknown', reasonCodes: ['RECOVERY_EVIDENCE_MISSING'] });
});

for (const [name, edit, status, reason] of [
  ['divergence at 20 ms', input => { input.clockSamples[4].monotonic_ms -= 20; }, 'valid'],
  ['divergence at 20.001 ms', input => { input.clockSamples[4].monotonic_ms -= 20.001; },
    'invalid', 'CLOCK_DIVERGENCE_EXCEEDED'],
  ['gap at 1,000 ms', input => { input.clockSamples = clockSamples(1000); }, 'valid'],
  ['gap at 1,001 ms', input => { input.clockSamples = clockSamples(1001); }, 'invalid', 'CLOCK_GAP_EXCEEDED'],
  ['reversing 25 ms wall-clock step', input => { input.clockSamples[4].wall_ms += 25; },
    'invalid', 'CLOCK_DIVERGENCE_EXCEEDED'],
  ['clock reset after start does not move the workload bracket', input => { input.clockSamples[4].wall_ms = start; },
    'invalid', 'CLOCK_SAMPLE_INVALID'],
  ['workload start not bracketed', input => { input.clockSamples.shift(); }, 'invalid', 'CLOCK_BRACKET_MISSING'],
  ['cleanup start not bracketed', input => {
    input.clockSamples = input.clockSamples.filter(sample => sample.wall_ms < cleanup);
  }, 'invalid', 'CLOCK_BRACKET_MISSING'],
  ['nonincreasing monotonic timestamps', input => { input.clockSamples[4].monotonic_ms = input.clockSamples[3].monotonic_ms; },
    'invalid', 'CLOCK_SAMPLE_INVALID'],
  ['missing clock trace', input => { delete input.clockSamples; }, 'not_collected', 'CLOCK_TRACE_MISSING']
]) {
  test(name + ' is assessed independently of the workload', () => {
    const input = fixture();
    edit(input);
    const result = classifyTrialEvidence(input);
    assert.equal(result.clockIntegrity.status, status);
    assert.deepEqual(result.clockIntegrity.reasonCodes, reason === undefined ? [] : [reason]);
    assert.equal(result.attemptValidity.status, 'valid');
    assert.equal(result.workloadUsability.status, 'usable');
    assert.equal(result.recoveryEvidence.status, 'verified');
    if (reason !== undefined) {
      assert.deepEqual(result.cutoffOutcome, { status: 'unknown', reasonCodes: [reason] });
      assert.equal(result.recoveryEvidence.timing, null);
      assert.deepEqual(result.recoveryEvidence.reasonCodes, [reason]);
    } else {
      assert.equal(result.cutoffOutcome.status, 'recovered_in_window');
    }
  });
}

for (const [name, edit, reason, workload] of [
  ['failed setup', input => { input.trial.checks.proxy.http_status = 503; }, 'SETUP_INVALID', 'usable'],
  ['unhealthy candidate at preflight', input => { input.trial.checks.services.candidate[0].health = 'unhealthy'; },
    'SETUP_INVALID', 'usable'],
  ['fault not acknowledged', input => { input.events = input.events.filter(row => row.event !== 'fault_activated'); },
    'FAULT_NOT_ACKNOWLEDGED', 'usable'],
  ['workload accounting mismatch', input => { input.driver.summary.outcomes.http_error++; },
    'WORKLOAD_EVIDENCE_INVALID', 'unusable'],
  ['missing request completion', input => { input.requests[100].completed_ms = null; },
    'WORKLOAD_EVIDENCE_INVALID', 'unusable'],
  ['misordered request trace', input => { input.requests[100].seq = 100; }, 'WORKLOAD_EVIDENCE_INVALID', 'unusable']
]) {
  test(name + ' makes the attempt invalid while preserving independent assessments', () => {
    const input = fixture({ terminal: 'ROLLBACK_FAILED' });
    edit(input);
    const result = classifyTrialEvidence(input);
    assert.deepEqual(result.attemptValidity, { status: 'invalid', reasonCodes: [reason] });
    assert.equal(result.workloadUsability.status, workload);
    assert.deepEqual(result.cutoffOutcome, { status: 'unknown', reasonCodes: [reason] });
  });
}

test('classification is deterministic, versioned, and does not mutate its evidence', () => {
  const input = fixture();
  input.trial.checks.proxy.http_status = 503;
  input.driver.summary.settled = 1;
  input.clockSamples = clockSamples(1001);
  input.clockSamples[4].monotonic_ms -= 25;
  input.trial.observation.verified_at_ms++;
  const snapshot = structuredClone(input);
  const result = classifyTrialEvidence(input);
  assert.deepEqual(classifyTrialEvidence(input), result);
  assert.deepEqual(input, snapshot);
  assert.equal(result.classifierVersion, '1');
  assert.deepEqual(result.thresholds, {
    cutoffOffsetMs: 60_000,
    maxProbeCompletionLatenessMs: 200,
    maxClockDivergenceMs: 20,
    maxClockSampleGapMs: 1000
  });
  assert.deepEqual(result.cutoffOutcome.reasonCodes, [
    'SETUP_INVALID', 'WORKLOAD_EVIDENCE_INVALID', 'CLOCK_GAP_EXCEEDED', 'CLOCK_DIVERGENCE_EXCEEDED',
    'EVIDENCE_CONFLICT'
  ]);
});
