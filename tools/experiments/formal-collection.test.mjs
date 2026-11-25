import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateCollectionManifest, initializeCollection, inspectCollectionCommand, openCollection, validateCollectionManifest } from './formal-collection.mjs';

const gitRevision = 'a'.repeat(40);
const frozen = {
  project: 'wp4-fixture', proxyUrl: 'http://127.0.0.1:18080/api/work', host: 'fixture-host',
  stableConfigSha256: '1'.repeat(64), environmentFingerprint: '2'.repeat(64),
  composeConfigSha256: '3'.repeat(64), composeConfigRef: 'fixture:compose', preflightRef: 'fixture:preflight',
  imageDigests: { candidate: 'sha256:' + '4'.repeat(64) }
};
const authorization = { authorizedBy: 'fixture reviewer', reason: 'fixture review', evidenceRef: 'fixture:review' };
const reconciliation = { ...authorization, operationsSettled: true, resetVerified: true };

function fixture(t, options = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'formal-collection-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'collection');
  const manifest = options.manifest ?? generateCollectionManifest({ seed: '01234567', gitRevision, frozen });
  initializeCollection(directory, manifest, { mode: 'fixture' });
  const calls = [];
  const fixtureRunners = Object.fromEntries(['S1', 'S2', 'S3'].map(scenario => [scenario, async input => {
    const { arm, trialId, evidenceRoot } = input;
    calls.push({ scenario, arm, trialId });
    const startView = openCollection(directory).inspect();
    assert.equal(startView.status, 'started');
    assert.equal(startView.events.at(-1).trial.trialId, trialId);
    assert.equal(input.frozen.project, frozen.project);
    const path = join(evidenceRoot, trialId);
    mkdirSync(path);
    writeFileSync(join(path, 'raw.txt'), 'fixture', { flag: 'wx' });
    const outcome = {
      scenario, arm, trialId, runId: trialId + '-driver', directory: path,
      workflow: { deployment: 'FAILED', recovery: 'not_observed' },
      validity: { status: 'valid', issues: [] },
      nextArmAllowed: true, cleanup: { status: 'completed' },
      reset: { status: 'verified', event: { event: 'reset_verified', evidence: { fixture: true } } },
      ...options.outcome?.(calls.length)
    };
    if (options.crash === calls.length) throw new Error('fixture interruption before summary');
    writeFileSync(join(path, 'summary.json'), JSON.stringify(outcome), { flag: 'wx' });
    if (options.crashAfterSummary === calls.length) throw new Error('fixture interruption after summary');
    return outcome;
  }]));
  const deps = { fixtureRunners, verifyEnvironment: options.verifyEnvironment ?? (() => ({ gitRevision, frozen })),
    now: options.now ?? (() => new Date('2026-01-01T00:00:00Z')) };
  const resume = () => openCollection(directory, deps);
  return { directory, manifest, calls, resume, collection: resume() };
}

test('seeded manifest is reproducible, balanced and validates every identifier', () => {
  const first = generateCollectionManifest({ seed: '01' });
  assert.deepEqual(first, generateCollectionManifest({ seed: '01' }));
  const second = generateCollectionManifest({ seed: '02' });
  assert.notDeepEqual(first.pairs.map(pair => pair.plannedOrder), second.pairs.map(pair => pair.plannedOrder));
  for (const manifest of [first, second]) {
    validateCollectionManifest(manifest);
    assert.equal(manifest.pairs.length, 24);
    assert.equal(new Set(manifest.pairs.flatMap(pair => pair.original.arms.map(arm => arm.trialId))).size, 48);
    for (const scenario of ['S1', 'S2', 'S3']) {
      const pairs = manifest.pairs.filter(pair => pair.scenario === scenario);
      assert.equal(pairs.length, 8);
      assert.equal(pairs.filter(pair => pair.plannedOrder === 'HC').length, 4);
      assert.equal(pairs.filter(pair => pair.plannedOrder === 'CH').length, 4);
    }
  }
  first.pairs[1].original.arms[0].trialId = first.pairs[0].original.arms[0].trialId;
  assert.throws(() => validateCollectionManifest(first), /conflicts/);
});

test('all three runners follow exact assignments and retain valid deployment and recovery failures', async t => {
  const { collection, manifest, calls, resume } = fixture(t);
  const expected = manifest.pairs.flatMap(pair => pair.original.arms.map(({ scenario, arm, trialId }) => ({ scenario, arm, trialId })));
  for (const arm of expected) {
    assert.equal(resume().inspect().trial.trialId, arm.trialId);
    const result = await collection.runNext();
    assert.equal(result.type, 'outcome');
    assert.equal(result.outcome.workflow.deployment, 'FAILED');
    assert.equal(result.outcome.validity.status, 'valid');
  }
  assert.equal(resume().inspect().status, 'collection_complete');
  assert.deepEqual(calls, expected);
  assert.throws(() => collection.decidePair({ ...authorization, decision: 'replace' }), /not eligible/);
});

test('technical invalidity requires authorization and permits two fresh same-order whole-pair replacements', async t => {
  const { collection, manifest, calls, resume } = fixture(t, {
    outcome: count => count % 2 ? { validity: { status: 'invalid', issues: ['clock_missing'] } } : {}
  });
  const originalOrder = manifest.pairs[0].plannedOrder;
  for (let round = 1; round <= 3; round++) {
    const invalid = await resume().runNext();
    const valid = await resume().runNext();
    const replace = { ...authorization, decision: 'replace', matchingInvalid: true,
      technicalReason: 'No correlated clock makes intended comparison impossible', invalidTrialId: invalid.trialId };
    assert.equal(collection.inspect().status, 'pair_review_required');
    await assert.rejects(collection.runNext(), /pair_review_required/);
    assert.throws(() => collection.decidePair({ ...replace, authorizedBy: '' }), /authorizer/);
    assert.throws(() => collection.decidePair({ ...replace, technicalReason: '' }), /technical justification|limit/);
    if (round < 3) {
      assert.throws(() => collection.decidePair({ ...replace, invalidTrialId: valid.trialId }), /technical invalidity/);
      const decision = collection.decidePair(replace);
      assert.deepEqual(decision.rerunOf, [invalid.trialId, valid.trialId]);
    } else {
      assert.throws(() => collection.decidePair(replace), /limit/);
      collection.decidePair({ ...authorization, decision: 'retain', reason: 'Shortfall after cap' });
    }
  }
  assert.deepEqual(calls.map(call => call.arm), [...originalOrder.repeat(3)]);
  assert.equal(new Set(calls.map(call => call.trialId)).size, 6);
  assert.equal(resume().inspect().trial.pairId, manifest.pairs[1].pairId);
});

test('uncertain validity requires affirmative technical adjudication', async t => {
  const { collection } = fixture(t, {
    outcome: count => count === 1 ? { validity: { status: 'needs_review', issues: ['coverage'] } } : {}
  });
  const first = await collection.runNext();
  await collection.runNext();
  const decision = { ...authorization, decision: 'replace', invalidTrialId: first.trialId,
    matchingInvalid: true, technicalReason: 'Coverage missing for intended comparison' };
  assert.throws(() => collection.decidePair(decision), /technical invalidity/);
  assert.equal(collection.decidePair({ ...decision, adjudicatedValidity: 'invalid' }).decision, 'replace');
});

test('unsafe or contradictory reset evidence blocks continuation until explicit reconciliation', async t => {
  for (const unsafe of [{ nextArmAllowed: false }, { reset: { status: 'verified' } },
    { cleanup: { status: 'blocked' } }]) {
    const { collection, calls, resume } = fixture(t, { outcome: count => count === 1 ? unsafe : {} });
    const first = await collection.runNext();
    assert.equal(first.outcome.validity.status, 'valid');
    assert.equal(resume().inspect().status, 'reset_blocked');
    await assert.rejects(resume().runNext(), /reset_blocked/);
    assert.throws(() => resume().reconcile({ ...reconciliation, resetVerified: false }), /verified reset/);
    assert.equal(calls.length, 1);
    resume().reconcile(reconciliation);
    assert.equal((await resume().runNext()).type, 'outcome');
    assert.equal(calls.length, 2);
  }
});

test('interrupted arm remains unresolved and takes no second execution on resume', async t => {
  const { collection, directory, calls, resume } = fixture(t, { crash: 1 });
  const record = await collection.runNext();
  const raw = join(directory, 'fixture-evidence', record.trialId, 'raw.txt');
  assert.equal(resume().inspect().status, 'interrupted_or_unresolved');
  await assert.rejects(resume().runNext(), /unresolved/);
  assert.throws(() => resume().reconcile(reconciliation), /explicitly aborted/);
  const closed = resume().reconcile({ ...reconciliation, aborted: true });
  assert.equal(closed.outcome, undefined);
  await resume().runNext();
  assert.equal(new Set(calls.map(call => call.trialId)).size, 2);
  assert.equal(readFileSync(raw, 'utf8'), 'fixture');
  assert.equal(resume().inspect().status, 'pair_review_required');
});

test('a crash after summary publication recovers the original evidence and outcome', async t => {
  const { collection, directory, calls, resume } = fixture(t, { crashAfterSummary: 1 });
  const record = await collection.runNext();
  const summary = join(directory, 'fixture-evidence', record.trialId, 'summary.json');
  const original = readFileSync(summary, 'utf8');
  assert.throws(() => resume().reconcile({ ...reconciliation, aborted: true }), /Existing outcome/);
  assert.equal(resume().reconcile(reconciliation).outcome.validity.status, 'valid');
  await resume().runNext();
  assert.equal(readFileSync(summary, 'utf8'), original);
  assert.equal(calls.length, 2);
});

test('duplicate evidence and conflicting ledger entries fail closed', async t => {
  const { collection, directory, calls } = fixture(t);
  const root = join(directory, 'fixture-evidence');
  const existing = join(root, collection.inspect().trial.trialId);
  mkdirSync(root);
  mkdirSync(existing);
  await assert.rejects(collection.runNext(), /already exists/);
  rmdirSync(existing);
  await collection.runNext();
  const ledger = join(directory, 'ledger');
  const first = JSON.parse(readFileSync(join(ledger, '000001.json'), 'utf8'));
  writeFileSync(join(ledger, '000003.json'), JSON.stringify({ ...first, sequence: 3 }), { flag: 'wx' });
  assert.throws(() => collection.inspect(), /Conflicting arm start/);
  assert.equal(calls.length, 1);
});

test('concurrent starts cannot consume the same trial or start the paired arm', async t => {
  const { collection, resume, calls } = fixture(t);
  const results = await Promise.allSettled([collection.runNext(), resume().runNext()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(calls.length, 1);
  assert.equal(collection.inspect().trial.position, 2);
});

test('missing and inconsistent environment metadata prevent execution', async t => {
  const missing = fixture(t, { manifest: generateCollectionManifest({ seed: '01' }) });
  assert.equal((await missing.collection.runNext()).type, 'preflight_blocked');
  assert.equal(missing.calls.length, 0);
  const drift = fixture(t, { verifyEnvironment: () => ({ gitRevision, frozen: { ...frozen, host: 'other-host' } }) });
  assert.equal((await drift.collection.runNext()).type, 'preflight_blocked');
  assert.equal(drift.calls.length, 0);
  await assert.rejects(drift.resume().runNext(), /preflight_blocked/);
  drift.resume().reconcile(reconciliation);
  assert.equal(drift.resume().inspect().trial.position, 1);
  assert.throws(() => generateCollectionManifest({ seed: '01', frozen: { ...frozen, imageDigests: {} } }), /metadata/);
});

test('offline plan and inspect leave execution untouched and label simulation', async t => {
  const { directory, calls } = fixture(t);
  assert.equal(inspectCollectionCommand('plan', '01').pairs.length, 24);
  assert.throws(() => inspectCollectionCommand('run', directory), /Unknown offline command/);
  const status = inspectCollectionCommand('inspect', directory);
  assert.equal(status.mode, 'fixture');
  assert.equal(status.status, 'planned');
  assert.deepEqual(readdirSync(join(directory, 'ledger')), []);
  assert.deepEqual(calls, []);
});

test('partial summary remains immutable and requires explicit abort', async t => {
  const { collection, directory, resume } = fixture(t, { crash: 1 });
  const interrupted = await collection.runNext();
  const summary = join(directory, 'fixture-evidence', interrupted.trialId, 'summary.json');
  writeFileSync(summary, '{"partial":', { flag: 'wx' });
  assert.throws(() => resume().reconcile(reconciliation), /Unusable summary requires explicit abort/);
  const result = resume().reconcile({ ...reconciliation, aborted: true });
  assert.equal(result.unusableSummaryRef, summary);
  assert.equal(readFileSync(summary, 'utf8'), '{"partial":');
  assert.equal(resume().inspect().trial.position, 2);
});

test('a durable start alone blocks replay when terminal publication fails', async t => {
  let writes = 0;
  const { collection, resume, calls } = fixture(t, {
    now() {
      if (++writes === 2) throw new Error('fixture ledger interruption');
      return new Date('2026-01-01T00:00:00Z');
    }
  });
  await assert.rejects(collection.runNext(), /fixture ledger interruption/);
  const reopened = resume();
  assert.equal(reopened.inspect().status, 'interrupted_or_unresolved');
  assert.deepEqual(reopened.inspect().events.map(event => event.type), ['start']);
  await assert.rejects(reopened.runNext(), /unresolved/);
  assert.equal(reopened.reconcile(reconciliation).outcome.validity.status, 'valid');
  assert.equal(reopened.inspect().trial.position, 2);
  assert.equal(calls.length, 1);
});
