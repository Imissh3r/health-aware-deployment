import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeFormalPairs } from './summarize-formal-pairs.mjs';

const pairId = 'pair-01';
const cli = fileURLToPath(new URL('./summarize-formal-pairs.mjs', import.meta.url));

function round(round_id, a, b, order = 'AB') {
  const attempts = [{ arm: 'A', trial_id: a }, { arm: 'B', trial_id: b }];
  return { round_id, attempts: order === 'AB' ? attempts : attempts.toReversed() };
}

function manifest(rounds, assigned_order = 'AB') {
  return { schema_version: 2, pairs: [{ pair_id: pairId, assigned_order, rounds }] };
}

function record(trial_id, arm, {
  validity = 'valid', cutoff = 'recovered_in_window', timing = 'in_window',
  recoveryStatus = timing === null ? 'unverified' : 'verified',
  reasonCodes = [], pair_id = pairId, recorded_at = '2026-11-22T09:00:00.000Z'
} = {}) {
  return {
    schema_version: 1, trial_id, attempt_id: trial_id, pair_id, arm, recorded_at,
    classification: {
      classifierVersion: '1',
      attemptValidity: { status: validity, reasonCodes: validity === 'invalid' ? ['SETUP_INVALID'] : [] },
      cutoffOutcome: { status: cutoff, reasonCodes },
      recoveryEvidence: { status: recoveryStatus, timing },
      reviewFlags: []
    }
  };
}

function invalid(trialId, arm) {
  return record(trialId, arm, { validity: 'invalid', cutoff: 'unknown', timing: null });
}

function selectedTrialIds(pair) {
  return [pair.arms.A.selected_attempt?.trial_id ?? null, pair.arms.B.selected_attempt?.trial_id ?? null];
}

test('selects A2 and B2 together after B1 invalidates the first round', () => {
  const plan = manifest([round('round-01', 'a1', 'b1'), round('round-02', 'a2', 'b2')]);
  const summary = summarizeFormalPairs(plan, [record('a2', 'A'), record('b2', 'B'), record('a1', 'A'), invalid('b1', 'B')]);
  const [pair] = summary.pairs;
  assert.equal(pair.status, 'complete');
  assert.equal(pair.selected_round_id, 'round-02');
  assert.deepEqual(selectedTrialIds(pair), ['a2', 'b2']);
  assert.deepEqual(pair.rounds.map(entry => entry.status), ['invalid', 'valid']);
  assert.deepEqual(pair.rounds[0].attempts.map(a => [a.trial_id, a.attempt_validity.status]), [
    ['a1', 'valid'], ['b1', 'invalid']
  ]);
  assert.deepEqual(pair.review_flags, []);
  assert.deepEqual(summary.pair_counts, { complete: 1, incomplete: 0, unresolved: 0 });
});

test('skips multiple invalid rounds and retains all attempts in assigned BA order', () => {
  const plan = manifest([
    round('round-01', 'a1', 'b1', 'BA'), round('round-02', 'a2', 'b2', 'BA'), round('round-03', 'a3', 'b3', 'BA')
  ], 'BA');
  const [pair] = summarizeFormalPairs(plan, [
    record('a3', 'A'), record('b3', 'B'), invalid('a2', 'A'), record('b2', 'B'), record('a1', 'A'), invalid('b1', 'B')
  ]).pairs;
  assert.equal(pair.selected_round_id, 'round-03');
  assert.deepEqual(selectedTrialIds(pair), ['a3', 'b3']);
  assert.deepEqual(pair.rounds.map(entry => entry.status), ['invalid', 'invalid', 'valid']);
  assert.deepEqual(pair.rounds[0].attempts.map(attempt => attempt.trial_id), ['b1', 'a1']);
});

test('valid arms split across two invalid rounds leave the pair incomplete', () => {
  const plan = manifest([round('round-01', 'a1', 'b1'), round('round-02', 'a2', 'b2')]);
  const summary = summarizeFormalPairs(plan, [record('a1', 'A'), invalid('b1', 'B'), invalid('a2', 'A'), record('b2', 'B')]);
  const [pair] = summary.pairs;
  assert.equal(pair.status, 'incomplete');
  assert.deepEqual(selectedTrialIds(pair), [null, null]);
  assert.equal(summary.cutoff_counts.A.recovered_in_window, 0);
  assert.equal(summary.cutoff_counts.B.recovered_in_window, 0);
});

test('selects the first valid round with unknown and late outcomes, using manifest order', () => {
  const plan = manifest([round('z-first', 'z-a1', 'z-b1'), round('a-later', 'a2', 'b2')]);
  const records = [
    record('a2', 'A', { recorded_at: '2026-11-22T08:00:00.000Z' }), record('b2', 'B'),
    record('z-a1', 'A', { cutoff: 'unknown', timing: 'late', recorded_at: '2026-11-22T10:00:00.000Z' }),
    record('z-b1', 'B', { cutoff: 'unknown', timing: null })
  ];
  const summary = summarizeFormalPairs(plan, records);
  const [pair] = summary.pairs;
  assert.equal(pair.status, 'complete');
  assert.equal(pair.selected_round_id, 'z-first');
  assert.deepEqual(selectedTrialIds(pair), ['z-a1', 'z-b1']);
  assert.deepEqual(pair.review_flags, [{ code: 'ATTEMPT_AFTER_VALID_ROUND', round_ids: ['a-later'] }]);
  assert.equal(summary.cutoff_counts.A.unknown, 1);
  assert.equal(summary.cutoff_counts.A.verified_late, 1);
  assert.equal(summary.cutoff_counts.B.unknown, 1);
  assert.deepEqual(summarizeFormalPairs(plan, records.toReversed()), summary);
});

test('a partially recorded round leaves both arms unselected', () => {
  const plan = manifest([round('round-01', 'a1', 'b1', 'BA')], 'BA');
  const summary = summarizeFormalPairs(plan, [record('b1', 'B')]);
  const [pair] = summary.pairs;
  assert.equal(pair.status, 'incomplete');
  assert.deepEqual(selectedTrialIds(pair), [null, null]);
  assert.deepEqual(pair.review_flags, [
    { code: 'PLANNED_ATTEMPT_NOT_RECORDED', round_id: 'round-01', arm: 'A', trial_id: 'a1' }
  ]);
  assert.equal(summary.cutoff_counts.B.recovered_in_window, 0);
});

test('an earlier missing record blocks a later valid round until its disposition is recorded', () => {
  const firstRound = round('round-01', 'a1', 'b1');
  const plan = manifest([firstRound, round('round-02', 'a2', 'b2')]);
  const records = [invalid('a1', 'A'), record('a2', 'A'), record('b2', 'B')];
  const [unresolved] = summarizeFormalPairs(plan, records).pairs;
  assert.equal(unresolved.status, 'unresolved');
  assert.deepEqual(selectedTrialIds(unresolved), [null, null]);
  assert.deepEqual(unresolved.review_flags.map(flag => flag.code), [
    'PLANNED_ATTEMPT_NOT_RECORDED', 'EARLIER_ROUND_INCOMPLETE'
  ]);

  const disposition = { status: 'not_run', reason: 'Reset failed after Arm A and the round was closed after review.' };
  firstRound.attempts[1].disposition = disposition;
  const [resolved] = summarizeFormalPairs(plan, records).pairs;
  assert.equal(resolved.status, 'complete');
  assert.equal(resolved.rounds[0].status, 'invalid');
  assert.deepEqual(resolved.rounds[0].attempts[1], {
    trial_id: 'b1', arm: 'B', record_status: 'not_recorded', disposition
  });
  assert.deepEqual(selectedTrialIds(resolved), ['a2', 'b2']);
});

test('a later record for an interrupted attempt without a bundle requires review', () => {
  const firstRound = round('round-01', 'a1', 'b1');
  firstRound.attempts[0].disposition = { status: 'interrupted_without_bundle', reason: 'The host stopped mid-run.' };
  const plan = manifest([firstRound, round('round-02', 'a2', 'b2')]);
  const records = [record('b1', 'B'), record('a2', 'A'), record('b2', 'B')];
  const [resolved] = summarizeFormalPairs(plan, records).pairs;
  assert.equal(resolved.selected_round_id, 'round-02');
  const [conflict] = summarizeFormalPairs(plan, [...records, record('a1', 'A')]).pairs;
  assert.equal(conflict.status, 'unresolved');
  assert.deepEqual(selectedTrialIds(conflict), [null, null]);
  assert.ok(conflict.review_flags.some(flag => flag.code === 'ATTEMPT_DISPOSITION_CONFLICT'));
});

test('a missing later round leaves the first complete valid round selected', () => {
  const plan = manifest([round('round-01', 'a1', 'b1'), round('round-02', 'a2', 'b2')]);
  const [pair] = summarizeFormalPairs(plan, [record('a1', 'A'), record('b1', 'B')]).pairs;
  assert.equal(pair.status, 'complete');
  assert.equal(pair.selected_round_id, 'round-01');
  assert.deepEqual(pair.rounds.map(entry => entry.status), ['valid', 'incomplete']);
});

for (const [name, plan, code] of [
  ['missing pair plan', { schema_version: 2, pairs: [] }, 'MISSING_EXECUTION_ORDER'],
  ['missing round order', manifest(undefined), 'MISSING_EXECUTION_ORDER'],
  ['unlisted attempt', manifest([round('round-01', 'other', 'b1')]), 'ATTEMPT_NOT_IN_MANIFEST'],
  ['reversed arm order', manifest([round('round-01', 'a1', 'b1', 'BA')]), 'ARM_ORDER_CONFLICT'],
  ['duplicate trial assignment', manifest([round('round-01', 'a1', 'b1'), round('round-02', 'a1', 'b2')]), 'DUPLICATE_TRIAL_ASSIGNMENT'],
  ['duplicate round ID', manifest([round('round-01', 'a1', 'b1'), round('round-01', 'a2', 'b2')]), 'DUPLICATE_ROUND_ID'],
  ['duplicate pair plan', { schema_version: 2, pairs: [
    ...manifest([round('round-01', 'a1', 'b1')]).pairs, ...manifest([round('round-02', 'a2', 'b2')]).pairs
  ] }, 'DUPLICATE_PAIR_PLAN'],
  ['conflicting arm provenance', manifest([round('round-01', 'other', 'a1')]), 'ATTEMPT_PROVENANCE_CONFLICT']
]) {
  test(name + ' prevents selection and preserves evidence', () => {
    const [pair] = summarizeFormalPairs(plan, [record('a1', 'A')]).pairs;
    assert.equal(pair.status, 'unresolved');
    assert.deepEqual(selectedTrialIds(pair), [null, null]);
    assert.ok(pair.review_flags.some(flag => flag.code === code));
    const history = [...pair.rounds.flatMap(entry => entry.attempts), ...pair.unassigned_attempts];
    assert.ok(history.some(attempt => attempt.trial_id === 'a1' && attempt.record_status === 'recorded'));
  });
}

test('surfaces a V1 evidence conflict without replacing the first valid round', () => {
  const plan = manifest([round('round-01', 'a1', 'b1'), round('round-02', 'a2', 'b2')]);
  const [pair] = summarizeFormalPairs(plan, [
    record('a1', 'A', { cutoff: 'unknown', timing: null, recoveryStatus: 'untrusted', reasonCodes: ['EVIDENCE_CONFLICT'] }),
    record('b1', 'B'), record('a2', 'A'), record('b2', 'B')
  ]).pairs;
  assert.equal(pair.status, 'complete');
  assert.deepEqual(selectedTrialIds(pair), ['a1', 'b1']);
  assert.equal(pair.arms.A.selected_attempt.cutoff_outcome.status, 'unknown');
  assert.ok(pair.review_flags.some(flag => flag.code === 'EVIDENCE_CONFLICT'));
});

test('a trial ID assigned to two pairs leaves both pairs unresolved', () => {
  const plan = manifest([round('round-01', 'shared-trial', 'b1')]);
  plan.pairs.push({ pair_id: 'pair-02', assigned_order: 'AB', rounds: [round('round-01', 'shared-trial', 'b2')] });
  const summary = summarizeFormalPairs(plan, [record('shared-trial', 'A')]);
  assert.deepEqual(summary.pair_counts, { complete: 0, incomplete: 0, unresolved: 2 });
  for (const pair of summary.pairs) {
    assert.deepEqual(selectedTrialIds(pair), [null, null]);
    assert.ok(pair.review_flags.some(flag => flag.code === 'DUPLICATE_TRIAL_ASSIGNMENT'));
  }
  assert.equal(summary.pairs[1].rounds[0].attempts[0].record_status, 'conflict');
});

test('rejects flat version 1 manifests and undocumented dispositions', () => {
  assert.throws(() => summarizeFormalPairs({ schema_version: 1, pairs: [] }, []), /schema_version 2/);
  const firstRound = round('round-01', 'a1', 'b1');
  firstRound.attempts[0].disposition = { status: 'not_run', reason: '' };
  assert.throws(() => summarizeFormalPairs(manifest([firstRound]), []), /Invalid unrecorded-attempt disposition/);
});

test('reads the manifest and V1 attempt directory through the CLI without altering evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'formal-summary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const planPath = join(root, 'manifest.json');
  const logPath = join(root, 'formal-attempts');
  mkdirSync(logPath);
  const plan = manifest([round('round-01', 'a1', 'b1')]);
  const unknown = { cutoff: 'unknown', timing: null };
  const records = [record('b1', 'B', unknown), record('a1', 'A', unknown)];
  const originals = new Map([[planPath, JSON.stringify(plan)]]);
  for (const attempt of records) originals.set(join(logPath, attempt.trial_id + '.json'), JSON.stringify(attempt));
  originals.set(join(logPath, '.attempt-leftover.tmp'), '{');
  for (const [path, contents] of originals) writeFileSync(path, contents);
  const result = spawnSync(process.execPath, [cli, planPath, logPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary, summarizeFormalPairs(plan, records));
  assert.equal(summary.pair_counts.complete, 1);
  assert.equal(summary.cutoff_counts.A.unknown, 1);
  assert.equal(summary.cutoff_counts.B.unknown, 1);
  for (const [path, contents] of originals) assert.equal(readFileSync(path, 'utf8'), contents);
  assert.deepEqual(readdirSync(logPath).sort(), ['.attempt-leftover.tmp', 'a1.json', 'b1.json']);

  writeFileSync(join(logPath, 'unexpected.json'), JSON.stringify(records[0]));
  const conflicting = spawnSync(process.execPath, [cli, planPath, logPath], { encoding: 'utf8' });
  assert.equal(conflicting.status, 1);
  assert.equal(conflicting.stdout, '');
  assert.match(conflicting.stderr, /filename conflicts/);
});
