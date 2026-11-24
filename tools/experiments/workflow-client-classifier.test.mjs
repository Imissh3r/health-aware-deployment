import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyWorkflowClient } from './workflow-client-classifier.mjs';

const base = 9_000_000_000_000_000_000n;
const stamp = ms => base + BigInt(Math.round(ms * 1e6));
const event = (id, ms) => ({ id, host_monotonic_ns: String(stamp(ms)) });

function fixture({ skew = 0, ...options } = {}) {
  const run = {
    run_id: 'fixture', status: 'complete', target_url: 'http://127.0.0.1:19090/api/work',
    options: { rate: 5, duration_seconds: 120, warmup_seconds: 5, max_lateness_ms: 200, timeout_ms: 3000, max_concurrency: 50 },
    clock_alignment: {
      version: 1, source: 'process.hrtime.bigint',
      start_before_ns: String(stamp(-skew)), start_after_ns: String(stamp(skew)),
      end_before_ns: String(stamp(120100 - skew)), end_after_ns: String(stamp(120100 + skew)),
      elapsed_ns: '120100000000'
    }
  };
  const requests = Array.from({ length: 600 }, (_, index) => {
    const time = index * 200;
    return {
      run_id: run.run_id, seq: index + 1, scheduled_ms: time,
      dispatched_ms: time, completed_ms: time + 10,
      dispatch_delay_ms: 0, latency_ms: 10,
      outcome: 'http_error', http_status: 500, version: '2.0.0', warmup: time < 5000
    };
  });
  const input = {
    scenario: 'S2', arm: 'C', origin: event('deploy', 10000),
    recoveryApplicable: true, exposureConfirmed: true,
    restore: event('restore', 11000), intervention: null,
    run, requests, expectedTargetUrl: 'http://127.0.0.1:19090/api/work', ...options
  };
  const classify = () => classifyWorkflowClient(input);
  const edit = (scheduled, fields) => {
    const row = requests[scheduled / 200];
    Object.assign(row, fields);
    row.dispatch_delay_ms = row.dispatched_ms == null ? null : row.dispatched_ms - scheduled;
    row.latency_ms = row.completed_ms == null ? null : row.completed_ms - row.dispatched_ms;
  };
  const ok = (scheduled, completion = scheduled + 10, version = '1.0.0', dispatch = scheduled) =>
    edit(scheduled, { dispatched_ms: dispatch, completed_ms: completion, outcome: 'ok',
      http_status: 200, version });
  const miss = scheduled => edit(scheduled, { dispatched_ms: null, completed_ms: null,
    outcome: 'missed', miss_reason: 'late', http_status: null, version: null });
  return { input, classify, ok, edit, miss };
}

test('earliest certification wins among overlapping triples with out-of-order completions', () => {
  const { ok, edit, classify } = fixture();
  edit(10800, { completed_ms: 13500 });
  ok(11000, 13000);
  ok(11200, 11800);
  ok(11400, 11700);
  ok(11600, 11750);
  const { recovery } = classify();
  assert.equal(recovery.primary.status, 'recovered_in_window');
  assert.deepEqual(recovery.primary.milestone.requestIds, [57, 58, 59]);
  assert.deepEqual(recovery.primary.milestone.certification, Array(2).fill(String(stamp(11800))));
  assert.deepEqual(recovery.alternatives.map(item => item.requestIds), [[56, 57, 58], [57, 58, 59]]);
});

test('equal certifications use the lexicographically earliest sequence IDs', () => {
  const { ok, classify } = fixture();
  ok(11000, 11700);
  ok(11200, 11800);
  ok(11400, 11700);
  ok(11600, 11750);
  assert.deepEqual(classify().recovery.primary.milestone.requestIds, [56, 57, 58]);
});

test('pre-window late dispatch can qualify, but stays outside the offered denominator', () => {
  const { ok, edit, classify } = fixture({ scenario: 'S1', origin: event('deploy', 9990) });
  edit(9600, { completed_ms: 11500 });
  ok(9800, 10150, '2.0.0', 9995);
  ok(10000, 10200, '2.0.0', 10020);
  ok(10200, 10210, '2.0.0');
  const result = classify();
  assert.deepEqual(result.candidate.primary.milestone.requestIds, [50, 51, 52]);
  assert.deepEqual(result.accounting.crossovers, [50]);
  assert.equal(result.accounting.offered.length, 300);
  assert.ok(!result.accounting.dispatched.includes(50));
});

test('eligible misses and wrong-version or failed interleaved responses break streaks', () => {
  const { ok, edit, miss, classify } = fixture();
  miss(10800);
  ok(11000);
  miss(11200);
  ok(11400);
  ok(11600);
  ok(11800, 11810, '2.0.0');
  ok(12000);
  ok(12200);
  edit(12400, { completed_ms: 14000 });
  ok(12600);
  ok(12800);
  ok(13000);
  const result = classify();
  assert.deepEqual(result.accounting.missed.map(row => row.seq), [55, 57]);
  assert.deepEqual(result.recovery.primary.milestone.requestIds, [64, 65, 66]);
});

test('a pre-action miss between delayed eligible dispatches does not reset them', () => {
  const { input, ok, miss, classify } = fixture({ restore: event('restore', 11210) });
  input.run.options.max_lateness_ms = 250;
  ok(11000, 11230, '1.0.0', 11220);
  miss(11200);
  ok(11400);
  ok(11600);
  assert.deepEqual(classify().recovery.primary.milestone.requestIds, [56, 58, 59]);
});

for (const completion of [69999, 70000, 70001]) {
  test(`exclusive cutoff with certification at ${completion} ms`, () => {
    const { ok, classify } = fixture();
    ok(69400);
    ok(69600);
    ok(69800, completion);
    const { recovery, accounting, episodes } = classify();
    assert.equal(recovery.primary.status, completion < 70000 ? 'recovered_in_window' : 'no_in_window_recovery');
    assert.equal(recovery.late.status, completion < 70000 ? 'not_applicable' : 'late_recovery_observed');
    assert.equal(accounting.dispatched.length, 300);
    assert.equal(accounting.lateCompletions.includes(350), completion >= 70000);
    assert.equal(episodes.items[0].status, 'closed');
  });
}

test('clock uncertainty at cutoff and at the action remains explicit', () => {
  const cutoff = fixture({ skew: 2 });
  cutoff.ok(69400);
  cutoff.ok(69600);
  cutoff.ok(69800, 70000);
  let result = cutoff.classify();
  assert.equal(result.recovery.primary.status, 'insufficient_evidence');
  assert.equal(result.recovery.late.status, 'late_followup_unavailable_or_unknown');
  assert.ok(result.accounting.ambiguous.includes(351));
  assert.deepEqual(result.recovery.alternatives[0].certification, [String(stamp(69998)), String(stamp(70002))]);

  const action = fixture({ skew: 2 });
  action.ok(11000);
  action.ok(11200);
  action.ok(11400);
  result = action.classify();
  assert.equal(result.recovery.primary.status, 'insufficient_evidence');
  assert.equal(result.recovery.possiblePrimary, true);
});

test('complete non-recovery differs from missing or interrupted primary records', () => {
  const { classify, input, edit } = fixture({ restore: null });
  assert.equal(classify().recovery.primary.status, 'no_in_window_recovery');
  edit(12000, { outcome: 'interrupted', completed_ms: null });
  input.requests.splice(66, 1);
  const result = classify();
  assert.equal(result.recovery.primary.status, 'insufficient_evidence');
  assert.equal(result.accounting.completeness, 'partial');
  assert.deepEqual(result.accounting.unknownSlots, [67]);
  assert.equal(result.accounting.outcomes.interrupted, 1);
  assert.equal(result.episodes.items.at(-1).status, 'open');
});

test('missing results outside the primary observation do not invalidate it', () => {
  const { classify, input } = fixture({ restore: null });
  input.requests.splice(400);
  input.run.status = 'incomplete';
  Object.assign(input.run.clock_alignment, {
    end_before_ns: String(stamp(80000)), end_after_ns: String(stamp(80000)), elapsed_ns: '80000000000'
  });
  const result = classify();
  assert.equal(result.accounting.completeness, 'complete');
  assert.equal(result.recovery.primary.status, 'no_in_window_recovery');
  assert.equal(result.recovery.late.status, 'late_followup_unavailable_or_unknown');
});

test('late workflow recovery is descriptive and cleanup cannot generate it', () => {
  const { classify, input, ok } = fixture({ restore: event('restore', 70400) });
  ok(70400);
  ok(70600);
  ok(70800);
  let result = classify();
  assert.equal(result.recovery.actionCutoffMembership, 'post_cutoff_action');
  assert.equal(result.recovery.primary.status, 'no_in_window_recovery');
  assert.equal(result.recovery.late.status, 'late_recovery_observed');
  input.intervention = event('cleanup', 70810);
  result = classify();
  assert.equal(result.recovery.primary.status, 'no_in_window_recovery');
  assert.equal(result.recovery.late.status, 'late_followup_unavailable_or_unknown');
  input.intervention = event('emergency', 60000);
  assert.equal(classify().recovery.primary.status, 'insufficient_evidence');
});

test('successful prevention is a separate outcome and makes recovery inapplicable', () => {
  const { classify, ok } = fixture({
    arm: 'H', restore: null, exposureConfirmed: false,
    prevention: { rejected: event('rejected', 11000), stableContinuity: event('continuity', 70000) }
  });
  for (let time = 10000; time < 70000; time += 200) ok(time);
  const result = classify();
  assert.equal(result.prevention.status, 'successful_prevention');
  assert.equal(result.recovery.primary.status, 'not_applicable');
  assert.equal(result.recovery.late.status, 'not_applicable');
  assert.equal(result.episodes.completedTotalNs, '0');
});

test('either version closes an episode only with an in-window completion', () => {
  const { classify, ok } = fixture();
  ok(10200, 10210, '2.0.0');
  ok(10600);
  ok(69800, 70000, '2.0.0');
  const { episodes, recovery } = classify();
  assert.deepEqual(episodes.items.map(item => item.status), ['closed', 'closed', 'right_censored']);
  assert.equal(episodes.completedTotalNs, '400000000');
  assert.equal(episodes.items.at(-1).resolutionCompletion[0], String(stamp(70000)));
  assert.equal(recovery.primary.status, 'no_in_window_recovery');
});

test('missing external verification does not invalidate usable client metrics', () => {
  const { classify, ok } = fixture();
  ok(11000);
  ok(11200);
  ok(11400);
  const result = classify();
  assert.equal(result.externalVerification.completeness, 'insufficient');
  assert.equal(result.accounting.completeness, 'complete');
  assert.equal(result.recovery.primary.status, 'recovered_in_window');
});

test('rejects sequence corruption and ignores invalid dispatch/completion evidence', () => {
  const { classify, input, ok, edit } = fixture();
  ok(11000);
  ok(11200);
  ok(11400);
  edit(11200, { completed_ms: 11199 });
  assert.equal(classify().recovery.primary.status, 'insufficient_evidence');
  edit(11200, { dispatched_ms: 11401, completed_ms: 11410 });
  assert.ok(classify().trace.issues.some(issue => issue.reason === 'invalid_slot_or_dispatch'));
  input.requests.splice(57, 0, input.requests[56]);
  assert.equal(classify().accounting.reason, 'invalid_sequence');
});

test('S3 candidate and recovery use their respective origins and event IDs', () => {
  const { classify, ok } = fixture({
    scenario: 'S3', deployment: event('invoked', 6000), faultWriteStarted: event('write', 9990),
    origin: event('ack', 10000)
  });
  ok(6000, 6010, '2.0.0');
  ok(6200, 6210, '2.0.0');
  ok(6400, 6410, '2.0.0');
  ok(11000);
  ok(11200);
  ok(11400);
  const result = classify();
  assert.equal(result.candidate.actionId, 'invoked');
  assert.equal(result.candidate.cutoffEventId, 'write');
  assert.deepEqual(result.candidate.primary.milestone.sinceOriginNs, ['410000000', '410000000']);
  assert.deepEqual(result.recovery.primary.milestone.sinceOriginNs, ['1410000000', '1410000000']);
  assert.equal(result.events.origin.id, 'ack');
});

test('CSV-shaped rows keep offered late dispatches separate from primary exposures', () => {
  const { input, edit } = fixture({ origin: event('deploy', 9995) });
  edit(69800, { dispatched_ms: 69999, completed_ms: 70009 });
  const requests = input.requests.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value == null ? '' : String(value)])
  ));
  const { accounting } = classifyWorkflowClient({ ...input, requests });
  assert.deepEqual(accounting.afterCutoff, [{ seq: 350, outcome: 'http_error' }]);
  assert.equal(accounting.counts.offered, 300);
  assert.equal(accounting.counts.dispatched, 299);
  assert.equal(accounting.failureRate, 1);
});

test('unusable alignment and an empty response cohort leave downtime unobserved', () => {
  const { input, miss, classify } = fixture({ restore: null });
  for (let time = 10000; time < 70000; time += 200) miss(time);
  let result = classify();
  assert.equal(result.accounting.failureRate, null);
  assert.equal(result.episodes.completedTotalNs, null);
  assert.equal(result.recovery.primary.status, 'insufficient_evidence');
  assert.equal(result.episodes.completeness, 'insufficient');
  input.run.clock_alignment.end_after_ns = String(stamp(120101));
  input.run.clock_alignment.end_before_ns = String(stamp(120101));
  result = classify();
  assert.equal(result.accounting.reason, 'invalid_or_missing_clock');
});

test('one observed failure and 299 misses provide complete accounting but insufficient recovery evidence', () => {
  const { classify, miss } = fixture({ restore: null });
  for (let time = 10200; time < 70000; time += 200) miss(time);
  const result = classify();
  assert.equal(result.accounting.completeness, 'complete');
  assert.equal(result.accounting.counts.missed, 299);
  assert.equal(result.accounting.counts.dispatched, 1);
  assert.equal(result.recovery.primary.status, 'insufficient_evidence');
  assert.deepEqual(result.recovery.primary.negativeEvidenceGaps, ['primary_sampling_coverage_not_established']);
  const [episode] = result.episodes.items;
  assert.equal(episode.status, 'right_censored');
  assert.equal(episode.openAtCutoff, true);
  assert.equal(episode.firstFailure, 51);
  assert.equal(episode.lastSupportingFailure, 51);
  assert.deepEqual(episode.firstFailureDispatch, [String(stamp(10000)), String(stamp(10000))]);
  assert.deepEqual(episode.lastSupportingFailureDispatch, episode.firstFailureDispatch);
  assert.deepEqual(episode.censorAt, result.window.cutoff);
  assert.equal(episode.lowerBoundNs, '0');
});

test('a right-censored episode measures only through its last supporting failure', () => {
  const { classify, miss, ok } = fixture();
  for (let time = 10600; time < 70000; time += 200) miss(time);
  let result = classify();
  let [episode] = result.episodes.items;
  assert.equal(episode.status, 'right_censored');
  assert.equal(episode.lastSupportingFailure, 53);
  assert.equal(episode.lowerBoundNs, '400000000');
  assert.equal(episode.durationNs, null);

  ok(10400, 70000, '2.0.0');
  [episode] = classify().episodes.items;
  assert.equal(episode.status, 'right_censored');
  assert.equal(episode.nextSuccess, 53);
  assert.equal(episode.lowerBoundNs, '200000000');
  assert.equal(episode.openAtCutoff, true);

  ok(10400, 10410, '2.0.0');
  result = classify();
  [episode] = result.episodes.items;
  assert.equal(episode.status, 'closed');
  assert.equal(episode.openAtCutoff, false);
  assert.equal(episode.censorAt, null);
  assert.equal(episode.lowerBoundNs, null);
  assert.deepEqual(episode.durationNs, ['400000000', '400000000']);
});

test('a late triple survives incomplete primary evidence without asserting primary absence', () => {
  const { input, classify, edit, ok } = fixture({ restore: event('restore', 70400) });
  ok(70400);
  ok(70600);
  ok(70800);
  let result = classify();
  assert.equal(result.recovery.primary.status, 'no_in_window_recovery');
  assert.equal(result.recovery.late.primaryAbsenceEstablished, true);

  edit(12000, { outcome: 'interrupted', completed_ms: null });
  input.run.status = 'incomplete';
  result = classify();
  assert.equal(result.recovery.primary.status, 'insufficient_evidence');
  assert.equal(result.recovery.late.status, 'late_recovery_observed');
  assert.equal(result.recovery.late.primaryAbsenceEstablished, false);
  assert.deepEqual(result.recovery.late.milestone.requestIds, [353, 354, 355]);
  assert.deepEqual(result.recovery.late.milestone.certification, Array(2).fill(String(stamp(70810))));
  assert.equal(result.recovery.late.milestone.attribution, 'workflow');

  input.intervention = event('manual-restore', 70810);
  assert.equal(classify().recovery.late.status, 'late_followup_unavailable_or_unknown');
});

test('a late triple that overlaps cleanup timing is retained as uncertain evidence', () => {
  const { classify, ok } = fixture({
    skew: 2, restore: event('restore', 70395), intervention: event('cleanup', 70810)
  });
  ok(70400);
  ok(70600);
  ok(70800);
  const { recovery } = classify();
  assert.equal(recovery.late.status, 'late_followup_unavailable_or_unknown');
  assert.equal(recovery.late.milestone, null);
  assert.equal(recovery.interventionId, 'cleanup');
  assert.equal(recovery.alternatives[0].attribution, 'intervention_boundary_uncertain');
});

test('all frozen workload settings and the caller-supplied proxy binding are checked', () => {
  const { classify, input } = fixture();
  assert.equal(classify().configuration.status, 'compliant');
  for (const [field, value] of Object.entries({
    rate: 4, duration_seconds: 121, warmup_seconds: 6,
    timeout_ms: 2000, max_concurrency: 49, max_lateness_ms: 201
  })) {
    const previous = input.run.options[field];
    input.run.options[field] = value;
    const { configuration } = classify();
    assert.equal(configuration.status, 'noncompliant');
    assert.deepEqual(configuration.mismatches, [{ field, expected: previous, actual: value }]);
    input.run.options[field] = previous;
  }
  input.run.target_url = 'http://127.0.0.1:8080/api/work';
  let result = classify();
  assert.equal(result.configuration.status, 'noncompliant');
  assert.equal(result.configuration.mismatches[0].field, 'target_url');
  assert.equal(result.accounting.completeness, 'complete');
  assert.equal(result.recovery.primary.status, 'insufficient_evidence');

  delete input.expectedTargetUrl;
  result = classify();
  assert.equal(result.configuration.status, 'unverified');
  assert.deepEqual(result.configuration.unverified, ['frozen_target_url']);
  input.run.target_url = 'http://127.0.0.1:8080/health';
  assert.equal(classify().configuration.status, 'noncompliant');
});

test('run integrity is reported independently of accounting and established milestones', () => {
  const { classify, input, ok } = fixture();
  input.run.status = 'invalid';
  let result = classify();
  assert.equal(result.execution.status, 'invalid');
  assert.equal(result.configuration.status, 'compliant');
  assert.equal(result.requestIntegrity.status, 'complete');
  assert.equal(result.accounting.completeness, 'complete');
  assert.equal(result.recovery.primary.status, 'insufficient_evidence');
  assert.ok(result.recovery.primary.negativeEvidenceGaps.includes('driver_execution_unverified'));

  ok(11000);
  ok(11200);
  ok(11400);
  input.run.options.timeout_ms = 2010;
  result = classify();
  assert.equal(result.configuration.status, 'noncompliant');
  assert.equal(result.execution.status, 'invalid');
  assert.equal(result.recovery.primary.status, 'recovered_in_window');

  input.run.status = 'incomplete';
  input.run.invariants = { offered_accounted: false };
  input.requests.splice(400);
  result = classify();
  assert.equal(result.execution.status, 'incomplete');
  assert.ok(result.execution.issues.includes('failed_driver_invariants'));
  assert.equal(result.requestIntegrity.status, 'partial');
  assert.equal(result.accounting.completeness, 'complete');
  assert.equal(result.recovery.primary.status, 'recovered_in_window');

  input.run.status = 'complete';
  assert.equal(classify().execution.status, 'invalid');
});
