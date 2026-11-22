import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeFormalHttp, measureHttpWindow } from './analyze-formal-http.mjs';
import { recordFormalAttempt } from './record-formal-attempt.mjs';

const cli = fileURLToPath(new URL('./analyze-formal-http.mjs', import.meta.url));
const pairId = 'pair-01';
const start = 1_795_167_069_023;
const cutoff = start + 60_000;
const fault = start + 15_000;
const cleanup = cutoff + 1000;

function makeLab(t) {
  const root = mkdtempSync(join(tmpdir(), 'formal-http-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeTrial(root, trialId, arm, scenario, {
  planPairId = pairId, recoveryTimeMs = arm === 'A' ? 1000 : 3000
} = {}) {
  const failed = scenario === 'failed';
  const invalid = scenario === 'invalid';
  const verifiedAt = failed ? null : scenario === 'late' ? cutoff + 500 : fault + recoveryTimeMs;
  const deployment_id = 'deployment-' + trialId;
  const trial = {
    event: 'paired_pilot', trial_id: trialId, arm, deployment_id, preflight_only: false, failures: [],
    completed_at: new Date(cleanup).toISOString(), monitor_process: { exit_code: failed ? 1 : 0, signal: null },
    checks: {
      routing_state: { deployment_id: null, pending_deployment_id: null },
      config_upstreams: ['http://app:3000'], candidate_fault_flag: 'absent',
      services: Object.fromEntries(['db', 'app', 'candidate', 'nginx'].map(name =>
        [name, [{ state: 'running', health: name === 'nginx' ? null : 'healthy' }]])),
      proxy: { http_status: invalid ? 503 : 200, version: '1.0.0' }
    },
    observation: {
      cutoff_ms: cutoff, cleanup_started_ms: cleanup, runner_cleanup_deferred_through_cutoff: true,
      verified_at_ms: verifiedAt, recovery_verified_in_window: verifiedAt !== null && verifiedAt < cutoff,
      final_observation: failed ? {
        started_at_ms: cutoff, completed_at_ms: cutoff + 100, http_status: 500, version: '2.0.0'
      } : null
    }
  };
  const controller = failed ? {
    deployment_id, status: 'ROLLBACK_FAILED',
    recovery: { proxy_verified: false, failed_step: 'RESTORE_ROUTE', reason: 'Synthetic failure' }
  } : {
    deployment_id, status: 'ROLLED_BACK',
    recovery: {
      proxy_verified: true, verified_at: new Date(verifiedAt).toISOString(),
      verification: { passed: true, consecutive: 3 },
      last_proxy_observation: { http_status: 200, version: '1.0.0' }
    }
  };
  const special = { 74: 'http_error', 75: 'http_error', 76: 'timeout', 77: 'connection_error', 78: 'missed' };
  if (arm === 'B') special[299] = 'http_error';
  const counts = { ok: 0, http_error: 0, timeout: 0, connection_error: 0, driver_error: 0, interrupted: 0, missed: 0 };
  const requestRows = Array.from({ length: 300 }, (_, index) => {
    const outcome = scenario === 'all-window-requests-missed' && index * 200 >= 15_000
      ? 'missed' : special[index] ?? 'ok';
    counts[outcome]++;
    return [trialId, index + 1, index * 200, outcome === 'missed' ? '' : index * 200 + 5,
      outcome === 'ok' ? 5 : '', outcome, outcome === 'missed' ? 'late' : ''].join(',');
  });
  const driver = {
    run_id: trialId, status: 'complete', wall_start_ms: start,
    target_url: 'http://127.0.0.1:8080/api/work', review_required: false,
    options: { rate: 5, duration_seconds: 60, warmup_seconds: 5, timeout_ms: 3000,
      max_concurrency: 50, max_lateness_ms: 200 },
    summary: {
      offered: 300, dispatched: 300 - counts.missed, settled: 300 - counts.missed,
      missed: counts.missed, outcomes: counts, missed_by_reason: { late: counts.missed, concurrency: 0 }
    },
    invariants: { offered_accounted: true, dispatched_settled: true, record_count_and_sequence: true,
      missed_reasons_accounted: true }
  };
  const markers = [['promotion_verified', start - 1], ['driver_started', start], ['fault_activated', fault]];
  if (!failed) markers.push(['recovery_verified', verifiedAt]);
  const bundlePath = join(root, trialId);
  mkdirSync(bundlePath);
  writeFileSync(join(bundlePath, 'trial.json'), JSON.stringify(trial));
  writeFileSync(join(bundlePath, 'run.json'), JSON.stringify(driver));
  writeFileSync(join(bundlePath, 'controller.jsonl'), JSON.stringify(controller) + '\n');
  writeFileSync(join(bundlePath, 'requests.csv'), [
    'run_id,seq,scheduled_ms,completed_ms,latency_ms,outcome,miss_reason', ...requestRows
  ].join('\n') + '\n');
  writeFileSync(join(bundlePath, 'events.csv'), [
    'trial_id,arm,event,wall_ms', ...markers.map(([event, time]) => [trialId, arm, event, time].join(','))
  ].join('\n') + '\n');
  if (scenario !== 'missing-clock') {
    const samples = Array.from({ length: 245 }, (_, i) => JSON.stringify({
      wall_ms: start + i * 250, monotonic_ms: 10 + i * 250
    }));
    writeFileSync(join(bundlePath, 'clock-samples.jsonl'), samples.join('\n') + '\n');
  }
  return recordFormalAttempt({ pairId: planPairId, arm, bundlePath });
}

function plan(...ids) {
  return { schema_version: 2, pairs: [{
    pair_id: pairId, assigned_order: 'AB',
    rounds: ids.map(([a, b], index) => ({
      round_id: 'round-0' + (index + 1), attempts: [{ arm: 'A', trial_id: a }, { arm: 'B', trial_id: b }]
    }))
  }] };
}

test('uses scheduled offsets, excludes the cutoff, and counts HTTP errors and misses separately', () => {
  const result = measureHttpWindow([
    [14_999, 'http_error'], [15_000, 'http_error'], [15_200, 'timeout'], [15_400, 'driver_error'],
    [15_600, 'missed'], [59_999, 'connection_error'], [60_000, 'http_error']
  ].map(([scheduled_ms, outcome]) => ({ scheduled_ms, outcome })));
  assert.deepEqual(result, {
    scheduled: 5, dispatched: 4, http_error_rate: 1 / 4,
    successful_latency_ms: { samples: 0, p50: null, p95: null },
    outcomes: { ok: 0, http_error: 1, timeout: 1, connection_error: 1, driver_error: 1, interrupted: 0, missed: 1 }
  });
  assert.equal(measureHttpWindow([{ scheduled_ms: 15_000, outcome: 'missed' }]).http_error_rate, null);
});

test('uses nearest-rank latency percentiles only for successes scheduled inside the window', () => {
  const result = measureHttpWindow([
    { scheduled_ms: 14_999, outcome: 'ok', latency_ms: 0 },
    { scheduled_ms: 60_000, outcome: 'ok', latency_ms: 1_000 },
    { scheduled_ms: 17_000, outcome: 'http_error', latency_ms: 0 },
    ...Array.from({ length: 19 }, (_, i) => ({
      scheduled_ms: 15_000 + i * 200, outcome: 'ok', latency_ms: 20 - i
    })),
    { scheduled_ms: 59_999, completed_ms: 60_000, outcome: 'ok', latency_ms: 1 }
  ]);
  assert.deepEqual(result.successful_latency_ms, { samples: 20, p50: 10, p95: 19 });
  assert.equal(result.http_error_rate, 1 / 21);

  const one = measureHttpWindow([{ scheduled_ms: 15_000, outcome: 'ok', latency_ms: 0 }]);
  assert.deepEqual(one.successful_latency_ms, { samples: 1, p50: 0, p95: 0 });
});

test('rejects unrecognized outcome labels even outside the analysis window', () => {
  for (const scheduled_ms of [14_999, 15_000]) {
    assert.throws(() => measureHttpWindow([{ scheduled_ms, outcome: 'unexpected' }]),
      /Unexpected Driver V1 outcome: unexpected/);
  }
  assert.throws(() => measureHttpWindow([{ scheduled_ms: 15_000, outcome: 'constructor' }]),
    /Unexpected Driver V1 outcome: constructor/);
});

test('analyzes a late unknown and genuine non-recovery from the selected complete round', t => {
  const root = makeLab(t);
  const records = [
    writeTrial(root, 'a1', 'A', 'recovered'), writeTrial(root, 'b1', 'B', 'invalid'),
    writeTrial(root, 'a2', 'A', 'late'), writeTrial(root, 'b2', 'B', 'failed')
  ].map(result => result.record);
  const manifest = plan(['a1', 'b1'], ['a2', 'b2']);
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const attemptPath = join(root, 'formal-attempts', 'a2.json');
  const originalRecord = readFileSync(attemptPath);
  const tracePath = join(root, 'a2', 'requests.csv');
  const originalTrace = readFileSync(tracePath);
  const result = spawnSync(process.execPath, [cli, manifestPath, join(root, 'formal-attempts')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report, analyzeFormalHttp(manifest, records));
  assert.equal(report.schema_version, 2);
  assert.deepEqual(report.window_ms, { start_inclusive: 15_000, end_exclusive: 60_000 });
  assert.equal(report.rate_denominator, 'dispatched_requests');
  const [pair] = report.pairs;
  assert.equal(pair.selected_round_id, 'round-02');
  const { A, B } = pair.arms;
  assert.deepEqual([A.trial_id, B.trial_id], ['a2', 'b2']);
  assert.deepEqual([A.cutoff_outcome, B.cutoff_outcome], ['unknown', 'not_recovered_by_cutoff']);
  assert.equal(A.recovery_timing, 'late');
  assert.deepEqual([A.recovery_time_ms, B.recovery_time_ms], [null, null]);
  assert.equal(report.recovery_time_pair_count, 0);
  assert.equal(pair.differences.recovery_time_ms, null);
  for (const [arm, errors] of [[A, 1], [B, 2]]) {
    assert.equal(arm.requests.scheduled, 225);
    assert.equal(arm.requests.dispatched, 224);
    assert.equal(arm.requests.outcomes.missed, 1);
    assert.equal(arm.requests.outcomes.timeout, 1);
    assert.equal(arm.requests.outcomes.connection_error, 1);
    assert.equal(arm.requests.outcomes.http_error, errors);
    assert.equal(arm.requests.http_error_rate, errors / 224);
    assert.deepEqual(arm.requests.successful_latency_ms, { samples: 222 - errors, p50: 5, p95: 5 });
  }
  assert.ok(Math.abs(pair.differences.http_error_rate_percentage_points - 100 / 224) < 1e-12);
  assert.deepEqual(readFileSync(attemptPath), originalRecord);
  assert.deepEqual(readFileSync(tracePath), originalTrace);
});

test('reports in-window recovery timing only where it is available', t => {
  const root = makeLab(t);
  const A = writeTrial(root, 'a1', 'A', 'recovered').record;
  const B = writeTrial(root, 'b1', 'B', 'recovered').record;
  const unknown = writeTrial(root, 'b2', 'B', 'missing-clock').record;
  const recovered = analyzeFormalHttp(plan(['a1', 'b1']), [A, B]);
  assert.deepEqual([recovered.pairs[0].arms.A.recovery_time_ms, recovered.pairs[0].arms.B.recovery_time_ms], [1000, 3000]);
  assert.equal(recovered.pairs[0].differences.recovery_time_ms, 2000);
  assert.equal(recovered.recovery_time_pair_count, 1);
  assert.deepEqual(recovered.paired_effects.recovery_time_ms, {
    pair_count: 1, median: 2000, q1: 2000, q3: 2000, iqr: 0
  });
  const partial = analyzeFormalHttp(plan(['a1', 'b2']), [A, unknown]);
  assert.equal(partial.pairs[0].arms.B.cutoff_outcome, 'unknown');
  assert.equal(partial.pairs[0].arms.B.requests.http_error_rate, 2 / 224);
  assert.equal(partial.pairs[0].arms.B.recovery_time_ms, null);
  assert.equal(partial.pairs[0].differences.recovery_time_ms, null);
});

test('interpolates paired effects and counts contributing pairs for each metric independently', t => {
  const root = makeLab(t);
  const manifest = { schema_version: 2, pairs: [] };
  const records = [];
  const cases = [
    ['recovered', 'recovered', 1400],
    ['recovered', 'recovered', 1000],
    ['recovered', 'recovered', 900],
    ['recovered', 'recovered', 1100],
    ['late', 'failed'],
    ['all-window-requests-missed', 'failed']
  ];
  for (const [index, [scenarioA, scenarioB, recoveryTimeMs]] of cases.entries()) {
    const planPairId = 'pair-' + (index + 1);
    const a = planPairId + '-a';
    const b = planPairId + '-b';
    manifest.pairs.push({ ...plan([a, b]).pairs[0], pair_id: planPairId });
    records.push(
      writeTrial(root, a, 'A', scenarioA, { planPairId }).record,
      writeTrial(root, b, 'B', scenarioB, { planPairId, recoveryTimeMs }).record
    );
  }
  const report = analyzeFormalHttp(manifest, records);
  assert.equal(report.pair_counts.complete, 6);
  assert.equal(report.paired_effects.http_error_rate_percentage_points.pair_count, 5);
  assert.ok(Math.abs(report.paired_effects.http_error_rate_percentage_points.median - 100 / 224) < 1e-12);
  assert.equal(report.pairs[5].arms.A.requests.dispatched, 0);
  assert.equal(report.pairs[5].differences.http_error_rate_percentage_points, null);
  assert.equal(report.recovery_time_pair_count, 4);
  assert.deepEqual(report.paired_effects.recovery_time_ms, {
    pair_count: 4, median: 50, q1: -25, q3: 175, iqr: 200
  });

  const two = analyzeFormalHttp({ ...manifest, pairs: manifest.pairs.slice(0, 2) }, records.slice(0, 4));
  assert.deepEqual(two.paired_effects.recovery_time_ms, {
    pair_count: 2, median: 200, q1: 100, q3: 300, iqr: 200
  });
});

test('rejects changed source bytes or classifications when replaying a selected attempt', t => {
  const root = makeLab(t);
  const A = writeTrial(root, 'a1', 'A', 'recovered').record;
  const B = writeTrial(root, 'b1', 'B', 'recovered').record;
  const manifest = plan(['a1', 'b1']);
  const changed = structuredClone(A);
  changed.classification.cutoffOutcome.status = 'unknown';
  assert.throws(() => analyzeFormalHttp(manifest, [changed, B]), /matching usable V1 workload/);
  const metadata = join(root, 'a1', 'run.json');
  writeFileSync(metadata, readFileSync(metadata, 'utf8') + '\n');
  assert.throws(() => analyzeFormalHttp(manifest, [A, B]), /differs from attempt record: a1\/run\.json/);
});

test('reports incomplete pairs separately from the paired HTTP comparisons', t => {
  const A = writeTrial(makeLab(t), 'a1', 'A', 'recovered').record;
  const report = analyzeFormalHttp(plan(['a1', 'b1']), [A]);
  assert.deepEqual(report.pair_counts, { complete: 0, incomplete: 1, unresolved: 0 });
  assert.deepEqual(report.pairs, []);
  assert.equal(report.recovery_time_pair_count, 0);
  const empty = { pair_count: 0, median: null, q1: null, q3: null, iqr: null };
  assert.deepEqual(report.paired_effects, { http_error_rate_percentage_points: empty, recovery_time_ms: empty });
});
