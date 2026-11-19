import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./analyze-paired-trials.mjs', import.meta.url));
const settings = {
  rate: 5, duration_seconds: 60, warmup_seconds: 5, timeout_ms: 3000,
  max_concurrency: 50, max_lateness_ms: 200
};
const pilot = {
  A: { origin: 1794989238743, fault: [14932, 15418], first: 16003, confirmed: 18015, rollback: 18015, recovered: 22489, errors: 18 },
  B: { origin: 1794989624677, fault: [14940, 15398], first: 16007, confirmed: 18018, rollback: 31027, recovered: 32693, errors: 69 }
};

function writeJson(directory, name, value) {
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n');
}

function fixture(t, { miss = false, faultClearedMs = 61_000, fastTail = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'paired-analysis-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = ['A', 'B'].map(arm => {
    const directory = join(root, arm);
    mkdirSync(directory);
    const { origin, fault, first, confirmed, rollback, recovered, errors } = pilot[arm];
    const trialId = 'fixture-' + arm;
    const deploymentId = 'deployment-' + arm;
    const missCount = miss && arm === 'A' ? 1 : 0;
    const csv = ['run_id,seq,scheduled_ms,completed_ms,latency_ms,outcome,miss_reason,version'];
    for (let index = 0; index < 300; index++) {
      const error = index >= 75 && index < 75 + errors;
      const missed = missCount && index === 299;
      const scheduled = index * 200;
      const latency = error ? 999 : fastTail && index >= 298 ? 5 : Math.max(1, index - 74);
      const row = [
        trialId, index + 1, scheduled, missed ? '' : scheduled + latency, missed ? '' : latency,
        missed ? 'missed' : error ? 'http_error' : 'ok', missed ? 'concurrency' : '',
        missed ? '' : '"2.0.0, ""candidate""\nfixture"'
      ];
      csv.push(row.join(','));
    }
    writeFileSync(join(directory, 'requests.csv'), csv.join('\r\n') + '\r\n');
    writeJson(directory, 'run.json', {
      run_id: trialId, status: 'complete', wall_start_ms: origin, review_required: false,
      target_url: 'http://127.0.0.1:8080/api/work', options: settings,
      git: { commit: '166e1f820856d60995bf29b1a0bf09b723a62c72', working_tree: 'dirty' },
      invariants: {
        offered_accounted: true, dispatched_settled: true, record_count_and_sequence: true,
        missed_reasons_accounted: true
      },
      summary: {
        offered: 300, dispatched: 300 - missCount, settled: 300 - missCount, missed: missCount,
        missed_by_reason: { late: 0, concurrency: missCount },
        outcomes: {
          ok: 300 - errors - missCount, http_error: errors, timeout: 0, connection_error: 0,
          driver_error: 0, interrupted: 0, missed: missCount
        }
      }
    });
    writeJson(directory, 'trial.json', {
      trial_id: trialId, deployment_id: deploymentId, arm, preflight_only: false,
      status: 'TRIAL_PASSED', controller_status: 'ROLLED_BACK', failures: [],
      reset_checks: {
        routing_state: { deployment_id: null, pending_deployment_id: null },
        candidate_fault_flag: 'absent', proxy: { http_status: 200, version: '1.0.0' }
      }
    });
    const markers = [
      ['trial_start', -4400, 'runner'], ['reset_verified', -3100, 'runner'],
      ['promotion_verified', -95, 'controller'], ['driver_spawned', -60, 'runner'],
      ['driver_started', 0, 'driver'], ['fault_activation_started', fault[0], 'runner'],
      ['fault_activated', fault[1], 'runner'], ['first_failure_probe', first, 'controller'],
      ['failure_confirmed', confirmed, 'controller'],
      ...(arm === 'B' ? [['rollback_reconfirmed', rollback, 'controller']] : []),
      ['rollback_started', rollback, 'controller'], ['recovery_verified', recovered, 'controller'],
      ['fault_cleared', faultClearedMs, 'runner'], ['reset_verified', 62_000, 'runner']
    ];
    writeFileSync(join(directory, 'events.csv'), 'trial_id,arm,event,wall_ms,source\n' +
      markers.map(([name, offset, source]) => [trialId, arm, name, origin + offset, source].join(',')).join('\n') + '\n');

    const iso = offset => new Date(origin + offset).toISOString();
    const common = {
      deployment_id: deploymentId, expected_version: '2.0.0',
      first_failure_probe_at: iso(first), confirmed_at: iso(confirmed)
    };
    const controller = [];
    const failed = { http_status: 500, version: '2.0.0' };
    if (arm === 'B') {
      controller.push({
        ...common, status: 'OPERATOR_DELAY_STARTED', operator_delay_ms: 10_000, first_confirmation: failed
      });
    }
    controller.push({
      ...common, status: 'ROLLED_BACK', confirmation: failed,
      ...(arm === 'B' ? { operator_delay_ms: 10_000, reconfirmed_at: iso(rollback) } : {}),
      recovery: {
        started_at: iso(rollback), verified_at: iso(recovered), proxy_verified: true,
        last_proxy_observation: { http_status: 200, version: '1.0.0' },
        verification: { passed: true, consecutive: 3 }
      }
    });
    writeFileSync(join(directory, 'controller.jsonl'), controller.map(event => JSON.stringify(event)).join('\n') + '\n');
    return directory;
  });
  return dirs;
}

function invoke(dirs, ...options) {
  const result = spawnSync(process.execPath, [cli, ...options, ...dirs], {
    encoding: 'utf8', timeout: 5000
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function snapshot(dirs) {
  return dirs.map(dir => Object.fromEntries(readdirSync(dir).map(name => [
    name, readFileSync(join(dir, name))
  ])));
}

test('derives the published pilot counts and times from synthetic evidence without writing to it', t => {
  const dirs = fixture(t);
  const before = snapshot(dirs);
  const result = invoke(dirs, '--json');
  assert.equal(result.status, 0, result.stderr);
  const pair = JSON.parse(result.stdout);
  assert.equal(pair.status, 'PAIR_VALID');
  assert.deepEqual(pair.window_ms, { start_inclusive: 15000, end_exclusive: 60000 });
  assert.deepEqual([pair.arms.A.requests.scheduled, pair.arms.B.requests.scheduled], [225, 225]);
  assert.deepEqual([pair.arms.A.requests.outcomes.http_error, pair.arms.B.requests.outcomes.http_error], [18, 69]);
  assert.deepEqual([pair.arms.A.requests.outcomes.ok, pair.arms.B.requests.outcomes.ok], [207, 156]);
  assert.equal(pair.arms.A.requests.http_error_rate, 18 / 225);
  assert.equal(pair.arms.B.requests.http_error_rate, 69 / 225);
  assert.deepEqual(pair.arms.A.requests.successful_latency_ms, { samples: 207, p50: 122, p95: 215 });
  assert.deepEqual(pair.arms.B.requests.successful_latency_ms, { samples: 156, p50: 147, p95: 218 });
  assert.equal(pair.arms.A.recovery.fault_ack_to_recovery_ms, 7071);
  assert.equal(pair.arms.B.recovery.fault_ack_to_recovery_ms, 17295);
  assert.equal(pair.arms.B.recovery.configured_operator_delay_ms, 10000);
  assert.equal(pair.arms.B.recovery.confirmation_to_reconfirmation_ms, 13009);
  assert.equal(pair.arms.A.recovery.confirmation_to_reconfirmation_ms, null);
  assert.equal(pair.arms.A.git.working_tree, 'dirty');
  assert.deepEqual(snapshot(dirs), before);
});

test('prints a readable comparison with separate configured delay and observed interval', t => {
  const dirs = fixture(t);
  const result = invoke(dirs);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| HTTP errors \| 18 \| 69 \|/);
  assert.match(result.stdout, /\| Configured operator delay \| — \| 10.000 s \|/);
  assert.match(result.stdout, /\| Confirmation → reconfirmation \| — \| 13.009 s \|/);
  assert.match(result.stdout, /\| Fault acknowledgment → verified recovery \| 7.071 s \| 17.295 s \|/);
});

test('uses dispatched requests as the rate denominator and counts misses separately', t => {
  const result = invoke(fixture(t, { miss: true }), '--json');
  assert.equal(result.status, 0, result.stderr);
  const { A } = JSON.parse(result.stdout).arms;
  assert.equal(A.requests.scheduled, 225);
  assert.equal(A.requests.dispatched, 224);
  assert.equal(A.requests.outcomes.missed, 1);
  assert.equal(A.requests.success_rate, 206 / 224);
  assert.equal(A.requests.http_error_rate, 18 / 224);
  assert.equal(A.requests.successful_latency_ms.samples, 206);
});

test('accepts cleanup after the final completion and before the nominal window ends', t => {
  const result = invoke(fixture(t, { faultClearedMs: 59_900, fastTail: true }), '--json');
  assert.equal(result.status, 0, result.stderr);
  const pair = JSON.parse(result.stdout);
  assert.equal(pair.window_ms.end_exclusive, 60_000);
  assert.equal(pair.arms.A.requests.scheduled, 225);
  assert.equal(pair.arms.B.requests.scheduled, 225);
});

test('rejects cleanup after the final request is scheduled but before it completes', t => {
  const result = invoke(fixture(t, { faultClearedMs: 59_804, fastTail: true }), '--json');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Fault cleared before the last recorded request time/);
});

test('rejects missing artifacts and reversed arms without printing a comparison', t => {
  const dirs = fixture(t);
  const reversed = invoke([...dirs].reverse(), '--json');
  assert.equal(reversed.status, 1);
  assert.equal(reversed.stdout, '');
  assert.match(reversed.stderr, /Arm A .*requested arm/);
  rmSync(join(dirs[1], 'controller.jsonl'));
  const missing = invoke(dirs, '--json');
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Arm B .*controller\.jsonl/);
});

for (const [name, edit, message] of [
  ['review flag', run => { run.review_required = true; }, /incomplete or needs review/],
  ['false invariant', run => { run.invariants.offered_accounted = false; }, /incomplete or needs review/],
  ['outcome mismatch', run => { run.summary.outcomes.http_error++; }, /does not agree with request accounting/],
  ['workload mismatch', run => { run.options.timeout_ms++; }, /Workload settings differ/]
]) {
  test('rejects ' + name, t => {
    const dirs = fixture(t);
    const run = JSON.parse(readFileSync(join(dirs[1], 'run.json'), 'utf8'));
    edit(run);
    writeJson(dirs[1], 'run.json', run);
    const result = invoke(dirs, '--json');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
  });
}

test('rejects a timestamp disagreement between the event CSV and controller log', t => {
  const dirs = fixture(t);
  const events = join(dirs[1], 'events.csv');
  const text = readFileSync(events, 'utf8');
  const verified = pilot.B.origin + pilot.B.recovered;
  writeFileSync(events, text.replace('recovery_verified,' + verified, 'recovery_verified,' + (verified + 1)));
  const result = invoke(dirs, '--json');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /disagree on recovery_verified/);
});
