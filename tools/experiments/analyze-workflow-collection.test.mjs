import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateCollectionManifest, generateRehearsalManifest, initializeCollection, openCollection } from './formal-collection.mjs';
import { readWorkload } from './run-formal-healthy-release.mjs';
import { classifyWorkflowClient } from './workflow-client-classifier.mjs';
import { analyzeWorkflowCollection, writeWorkflowReports } from './analyze-workflow-collection.mjs';

const S = 1_000_000_000n;
const base = 1_000n * S;
const sha = value => createHash('sha256').update(value).digest('hex');
const gitRevision = 'a'.repeat(40);
const frozen = {
  project: 'wp5-fixture', proxyUrl: 'http://127.0.0.1:18080/api/work', host: 'fixture',
  stableConfigSha256: '1'.repeat(64), environmentFingerprint: '2'.repeat(64),
  composeConfigSha256: sha('sanitized fixture compose'), composeConfigRef: 'compose.txt', preflightRef: 'preflight.json',
  imageDigests: { candidate: 'sha256:' + '4'.repeat(64) }
};
const review = { authorizedBy: 'fixture reviewer', reason: 'fixture review', evidenceRef: 'fixture:review' };
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
const columns = 'run_id,seq,scheduled_ms,dispatched_ms,completed_ms,dispatch_delay_ms,latency_ms,outcome,http_status,error_code,miss_reason,version,warmup';

function fixture(t, behavior = () => ({})) {
  const parent = mkdtempSync(join(tmpdir(), 'wp5-fixture-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'collection');
  const manifest = generateCollectionManifest({ seed: '01', gitRevision, frozen });
  initializeCollection(root, manifest, { mode: 'fixture' });
  writeFileSync(join(root, 'compose.txt'), 'sanitized fixture compose');
  write(join(root, 'preflight.json'), { synthetic: true });
  const fixtureRunners = Object.fromEntries(['S1', 'S2', 'S3'].map(scenario => [scenario, input =>
    syntheticTrial(scenario, input, behavior(scenario, input))]));
  const collection = openCollection(root, { fixtureRunners, verifyEnvironment: () => ({ gitRevision, frozen }) });
  const run = async (n = 1) => {
    for (let index = 0; index < n; index++) {
      const next = await collection.runNext();
      if (next.type !== 'outcome') return next;
    }
  };
  return { root, parent, manifest, collection, run, report: () => analyzeWorkflowCollection(root) };
}

function syntheticTrial(scenario, { arm, trialId, evidenceRoot, frozen: trialEnvironment = frozen }, config) {
  const runId = trialId + '-driver';
  const directory = join(evidenceRoot, trialId);
  mkdirSync(directory);
  if (config.interrupt) throw new Error('synthetic interruption');
  const events = [];
  const at = (name, seconds, fields = {}) => {
    const event = { id: trialId + ':' + (events.length + 1), event: name,
      host_monotonic_ns: String(base + BigInt(Math.round(seconds * 1e9))), ...fields };
    events.push(event);
    return event;
  };
  const clockWidth = config.clockWidth ?? 0n;
  const clock = { version: 1, source: 'process.hrtime.bigint', start_before_ns: String(base - clockWidth),
    start_after_ns: String(base + clockWidth), end_before_ns: String(base + 120n * S - clockWidth),
    end_after_ns: String(base + 120n * S + clockWidth),
    elapsed_ns: String(120n * S) };
  at('trial_started', -1, { arm, scenario, runId, trialId, frozen: trialEnvironment });
  at('preflight_passed', -1);
  at('driver_start_notification_received', 0.01, { payload: { event: 'driver_start', run_id: runId, clock_alignment: clock } });
  const probes = scenario === 'S2' ? ['/api/work', '/health', '/ready'].map((path, i) =>
    at('direct_candidate_precondition_probe', 5.3 + 0.1 * i, { path, source_clock_correlated: true,
      observation: { http_status: i === 0 ? 500 : 200, version: '2.0.0' } })) : [];
  const confirmation = probes.length ? at('fault_independently_confirmed', 5.5, {
    source_sample_ids: probes.map(probe => probe.id)
  }) : undefined;
  const deployment = at('deployment_invoked', 6, { ...(scenario !== 'S3' && { cutoff_ns: String(base + 66n * S) }),
    ...(confirmation && { fault_confirmation_id: confirmation.id }) });
  const prevention = scenario === 'S2' && arm === 'H' && !config.unexpected;
  const deploymentStatus = config.failure ? arm === 'H' ? 'PROMOTION_FAILED' : 'FAILED'
    : prevention ? 'PROMOTION_BLOCKED' : arm === 'H' ? 'PROMOTED' : 'SWITCHED';
  const command = { status: deploymentStatus, ...(arm === 'H' ? { event: 'candidate_promotion' }
    : { event: 'conventional_release', action: 'switch' }),
  ...(['PROMOTED', 'SWITCHED'].includes(deploymentStatus) && { deployment_id: 'synthetic-deployment' }) };
  const exit = ['PROMOTED', 'SWITCHED'].includes(deploymentStatus) ? 0 : 1;
  at('deployment_returned', 6.1, { outcome: command, ...(scenario === 'S1' ? { exitCode: exit, signal: null }
    : { execution: { exit_code: exit, signal: null } }) });
  write(join(directory, 'deployment.stdout.log'), command);
  writeFileSync(join(directory, 'deployment.stderr.log'), '');
  const writeStart = scenario === 'S3' && !config.failure ? at('fault_write_started', 18) : undefined;
  const origin = scenario === 'S3'
    ? writeStart && at('fault_write_acknowledged', 20, { cutoff_ns: String(base + 80n * S), write_start_id: writeStart.id })
    : deployment;
  if (!origin) at('fault_stage_not_reached', 7, { reason: 'deployment_failure' });
  const exposed = !prevention && !config.failure && scenario !== 'S1';
  const detectAt = config.uncertain ? 19 : scenario === 'S3' ? arm === 'H' && config.restoreAt ? config.restoreAt : 24 : 10;
  const restoreAt = config.restoreAt ?? (scenario === 'S3' ? arm === 'H' ? detectAt : 34 : arm === 'H' ? 10 : 20);
  const samples = exposed && arm === 'C' ? [detectAt - 2, detectAt - 1, detectAt].map(seconds =>
    at('external_probe', seconds, { observation: { http_status: 500, version: '2.0.0' } }).id) : [];
  const alert = samples.length ? at('external_alert', detectAt, { role: 'decision_alert', source_sample_ids: samples }) : undefined;
  const receipt = exposed && arm === 'H' ? at('monitor_timing_received', detectAt, {
    marker: { event: 'locked_degradation_confirmed', occurred_monotonic_ns: String(base + BigInt(detectAt) * S) }
  }) : undefined;
  const locked = receipt ? at('monitor_locked_confirmation', detectAt, { source_event_id: receipt.id }) : undefined;
  const restore = exposed && !config.noRestore ? at(arm === 'H' ? 'automatic_restore_started' : 'operator_restore_invoked',
    restoreAt, { role: 'normal_workflow_restore', ...(receipt && { source_event_id: receipt.id }),
      ...(alert && { alert_id: alert.id, due_monotonic_ns: String(base + BigInt(detectAt + 10) * S) }) }) : null;
  const rejected = prevention ? at('promotion_rejected', 6.1) : undefined;
  const stableContinuity = prevention ? at('stable_continuity_verified', 66) : undefined;
  at('driver_clock_reconciliation', 120.1, { passed: true });
  if (config.cleanupAt !== undefined) at('cleanup_restore_invoked', config.cleanupAt, { role: 'cleanup_restore' });
  const reset = at('reset_verified', 121, { evidence: { synthetic: true } });
  writeFileSync(join(directory, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const raw = join(directory, runId);
  mkdirSync(raw);
  write(join(raw, 'run.json'), { run_id: runId, status: 'complete', target_url: trialEnvironment.proxyUrl, clock_alignment: clock,
    git: { commit: gitRevision, working_tree: 'clean' },
    options: { rate: 5, duration_seconds: 120, warmup_seconds: 5, timeout_ms: 3000, max_concurrency: 50, max_lateness_ms: 200 } });
  const rows = Array.from({ length: 600 }, (_, index) => {
    const offset = 200 * index;
    const seconds = offset / 1000;
    const candidate = !prevention && !config.failure && seconds >= (arm === 'H' ? 7 : 8) &&
      (!restore || seconds < restoreAt) && (config.cleanupAt === undefined || seconds < config.cleanupAt);
    const failed = exposed && candidate && seconds >= (scenario === 'S3' ? 20 : 8);
    const latency = config.exactCutoff && offset >= 79600 && offset < 80200 ? 80000 - offset : 10;
    return [runId, index + 1, offset, offset, offset + Math.max(0, latency), 0, Math.max(0, latency), failed ? 'http_error' : 'ok',
      failed ? 500 : 200, '', '', candidate ? '2.0.0' : '1.0.0', offset < 5000].join(',');
  });
  writeFileSync(join(raw, 'requests.csv'), [columns, ...rows].join('\n') + '\n');
  const workload = readWorkload(directory, runId);
  const inputs = { scenario, arm, origin: origin ?? null, ...(scenario === 'S3' && { deployment, faultWriteStarted: writeStart }),
    restore, intervention: null, exposureConfirmed: exposed, recoveryApplicable: exposed,
    prevention: { rejected, stableContinuity }, expectedTargetUrl: trialEnvironment.proxyUrl };
  const result = classifyWorkflowClient({ ...inputs, run: workload.run.value, requests: workload.requests.value });
  const files = Object.fromEntries(Object.entries(workload).map(([key, { value, ...fields }]) => [key, fields]));
  write(join(directory, 'classifier.json'), { inputs, result, files });
  const detection = alert ?? locked;
  const elapsed = (start, end) => ({ start_event_id: start.id, end_event_id: end.id,
    elapsed_ns: String(BigInt(end.host_monotonic_ns) - BigInt(start.host_monotonic_ns)) });
  const ns = origin && detection ? elapsed(origin, detection).elapsed_ns : null;
  const sinceWrite = writeStart && detection ? elapsed(writeStart, detection).elapsed_ns : null;
  const outcome = {
    arm, scenario, runId, trialId, directory, origin: origin ?? null, classifier: 'classifier.json',
    validity: config.invalid ? { status: 'invalid', issues: ['setup_or_clock_invalid'] }
      : config.review ? { status: 'needs_review', issues: ['observer_coverage_incomplete'] } : { status: 'valid', issues: [] },
    workflow: { deployment: deploymentStatus, alert, locked_confirmation: locked, restore,
      primary_deployment_to_alert: scenario === 'S2' && alert ? elapsed(origin, alert) : null,
      ...(scenario === 'S3' && { detection: detection ? {
        status: config.uncertain ? 'origin_uncertain' : detectAt >= 80 ? 'post_cutoff_action' : 'observed', event_id: detection.id, originating_event_id: origin.id,
        fault_write_start_id: writeStart.id, from_acknowledgment_ns: ns, from_write_start_ns: sinceWrite,
        ...(config.uncertain ? { onset_relative_bounds_ns: [ns, sinceWrite] } : { latency_ns: ns })
      } : { status: config.failure ? 'not_applicable' : 'not_observed' } }) },
    ...(scenario === 'S3' && { stage: origin ? 'FAULT_ACKNOWLEDGED' : 'STAGE_NOT_REACHED',
      fault_stage_reason: origin ? null : 'deployment_failure', fault_write_started: writeStart,
      deployment_invocation: deployment, preparation: { acknowledgment: origin ?? null } }),
    ...(confirmation && { preparation: { confirmation } }),
    metrics: { client_coverage: { primary_covered: true } }, cleanup: { status: 'completed' },
    reset: { status: 'verified', event: reset }, nextArmAllowed: true
  };
  const stored = JSON.parse(JSON.stringify(outcome));
  write(join(directory, 'summary.json'), stored);
  return stored;
}

const arm = (pair, label) => pair.attempts.at(-1).arms.find(item => item.arm === label);
const snap = root => Object.fromEntries(readdirSync(root, { recursive: true }).sort().flatMap(file =>
  lstatSync(join(root, file)).isFile() ? [[file, sha(readFileSync(join(root, file)))]] : []));

test('empty fixture has complete planned inventory and creates reproducible read-only reports', t => {
  const { root, parent, report } = fixture(t);
  const before = snap(root);
  const result = report();
  assert.equal(result.provenance.mode, 'synthetic_fixture');
  assert.equal(result.pairs.length, 24);
  assert.equal(result.pairs.flatMap(pair => pair.attempts[0].arms).length, 48);
  assert.equal(result.scenarios[0].measures.failed_requests.differencesCMinusH, null);
  const metadata = { analysisGitRevision: gitRevision, analysisTimestamp: '2026-11-01T00:00:00.000Z' };
  const first = join(parent, 'first');
  const second = join(parent, 'second');
  writeWorkflowReports(result, first, metadata);
  writeWorkflowReports(report(), second, metadata);
  assert.deepEqual(snap(first), snap(second));
  assert.deepEqual(snap(root), before);
  assert.throws(() => writeWorkflowReports(result, first, metadata), /EEXIST/);
  assert.throws(() => writeWorkflowReports(result, join(root, 'forbidden'), metadata), /outside/);
  assert.match(readFileSync(join(first, 'summary.md'), 'utf8'), /Synthetic fixture/);
});

test('selects only current replacement and preserves failed deployment and incomplete arm', async t => {
  const lab = fixture(t, (_, { trialId, arm: label }) => ({
    invalid: trialId.includes('p01-r01') && label === 'H',
    failure: trialId.includes('p01-r02') && label === 'H',
    interrupt: trialId.includes('p02-r01')
  }));
  await lab.run(2);
  const original = lab.manifest.pairs[0].original;
  lab.collection.decidePair({ ...review, decision: 'replace', matchingInvalid: true, technicalReason: 'fixture clock fault',
    invalidTrialId: original.arms.find(item => item.arm === 'H').trialId });
  await lab.run(3);
  const report = lab.report();
  const [first, second] = report.pairs;
  assert.equal(first.attempts[0].disposition, 'superseded');
  assert.match(first.acceptedAttemptId, /r02$/);
  assert.equal(arm(first, 'H').supporting.deployment, 'PROMOTION_FAILED');
  assert.equal(arm(first, 'H').metrics.deployment_overhead.status, 'censored');
  assert.equal(report.scenarios[0].measures.failed_requests.numericPairs, 1);
  assert.equal(report.scenarios[0].measures.deployment_overhead.numericPairs, 0);
  assert.ok(second.attempts[0].arms.some(item => item.status === 'interrupted'));
  assert.equal(second.acceptedAttemptId, null);
});

test('S2 prevention and unexpected H promotion stay distinct from C primary recovery', async t => {
  const lab = fixture(t, (scenario, { trialId }) => ({ unexpected: scenario === 'S2' && trialId.includes('p02-') }));
  await lab.run(20);
  const report = lab.report();
  const [first, second] = report.pairs.filter(pair => pair.scenario === 'S2');
  assert.equal(arm(first, 'H').supporting.prevention.status, 'successful_prevention');
  assert.equal(arm(first, 'H').metrics.recovery_time.status, 'not_applicable');
  assert.equal(arm(second, 'H').supporting.clientRecovery.status, 'recovered_in_window');
  assert.equal(arm(second, 'C').metrics.recovery_time.status, 'observed');
  assert.equal(report.scenarios[1].measures.recovery_time.numericPairs, 0);
  assert.equal(report.scenarios[0].measures.deployment_overhead.differencesCMinusH.median, 1e9);
});

test('S3 preserves stage failure, signed origin bounds, strict cutoff, late and cleanup attribution', async t => {
  const lab = fixture(t, (scenario, { trialId, arm: label }) => {
    if (scenario !== 'S3') return {};
    if (trialId.includes('p01-')) return { failure: label === 'H' };
    if (trialId.includes('p02-')) return label === 'H' ? { uncertain: true } : { restoreAt: 79.6, exactCutoff: true };
    return label === 'H' ? { restoreAt: 82 } : { noRestore: true, cleanupAt: 82 };
  });
  await lab.run(38);
  const report = lab.report();
  const [first, second, third] = report.pairs.filter(pair => pair.scenario === 'S3');
  assert.equal(arm(first, 'H').supporting.stageReason, 'deployment_failure');
  assert.equal(arm(first, 'H').metrics.recovery_success.status, 'not_applicable');
  assert.deepEqual(arm(second, 'H').metrics.failure_detection_time.boundsNs, ['-1000000000', '1000000000']);
  assert.equal(arm(second, 'C').metrics.recovery_success.value, 'no_in_window_recovery');
  assert.equal(arm(second, 'C').supporting.lateRecovery.status, 'late_recovery_observed');
  assert.equal(arm(third, 'H').supporting.lateRecovery.status, 'late_recovery_observed');
  assert.notEqual(arm(third, 'C').supporting.lateRecovery.status, 'late_recovery_observed');
  assert.equal(report.scenarios[2].recoveryFlow.allAssigned, 16);
});

test('tampered, missing and traversal evidence fail closed without modifying input', async t => {
  const lab = fixture(t);
  await lab.run(2);
  const first = lab.report().pairs[0];
  const path = join(lab.root, arm(first, 'H').evidenceRef);
  const csv = join(path, arm(first, 'H').driverRunId, 'requests.csv');
  const original = readFileSync(csv);
  writeFileSync(csv, Buffer.concat([original, Buffer.from('tampered')]));
  const tampered = lab.report();
  assert.equal(tampered.pairs[0].acceptedAttemptId, null);
  assert.ok(tampered.audit.trials.flatMap(trial => trial.artifacts).some(file => file.status === 'corrupted'));
  rmSync(csv);
  assert.ok(lab.report().audit.trials.flatMap(trial => trial.artifacts).some(file => file.status === 'missing'));
  const outside = join(lab.parent, 'outside.csv');
  writeFileSync(outside, original);
  symlinkSync(outside, csv);
  assert.ok(lab.report().audit.trials.flatMap(trial => trial.artifacts).some(file => file.status === 'inconsistent'));
  assert.deepEqual(readFileSync(outside), original);
});

test('rejects conflicting IDs and ledger histories and leaves retained scoped review metric-specific', async t => {
  const lab = fixture(t, (_, { arm: label }) => ({ review: label === 'H' }));
  await lab.run(2);
  assert.equal(lab.report().pairs[0].acceptedAttemptId, null);
  lab.collection.decidePair({ ...review, decision: 'retain' });
  assert.ok(lab.report().pairs[0].acceptedAttemptId);
  const manifestPath = join(lab.root, 'manifest.json');
  const manifest = read(manifestPath);
  manifest.manifest.pairs[1].original.arms[0].trialId = manifest.manifest.pairs[0].original.arms[0].trialId;
  write(manifestPath, manifest);
  assert.equal(lab.report().audit.status, 'blocked');
});

test('a conflicting persisted classification and duplicate ledger start fail closed', async t => {
  const lab = fixture(t);
  await lab.run(2);
  const pair = lab.report().pairs[0];
  const path = join(lab.root, arm(pair, 'H').evidenceRef, 'classifier.json');
  const original = readFileSync(path);
  writeFileSync(path, '{"incomplete":');
  assert.ok(lab.report().audit.trials.flatMap(trial => trial.artifacts).some(file => file.status === 'corrupted'));
  const changed = JSON.parse(original);
  changed.result.accounting.counts.failed++;
  write(path, changed);
  const conflict = lab.report();
  assert.equal(conflict.pairs[0].acceptedAttemptId, null);
  assert.ok(conflict.audit.trials.flatMap(trial => trial.issues).some(issue => issue.code === 'classifier_replay_conflict'));
  const ledger = join(lab.root, 'ledger');
  const first = read(join(ledger, '000001.json'));
  write(join(ledger, '000005.json'), { ...first, sequence: 5 });
  assert.equal(lab.report().audit.status, 'blocked');
});

test('unavailable source provenance and nonconforming environment are distinguished', async t => {
  const lab = fixture(t);
  await lab.run(2);
  assert.equal(lab.report().audit.status, 'provenance_unverifiable');
  writeFileSync(join(lab.root, 'compose.txt'), 'different compose');
  const report = lab.report();
  assert.equal(report.audit.status, 'blocked');
  assert.equal(report.pairs[0].acceptedAttemptId, null);
  assert.ok(report.audit.collectionArtifacts.some(file => file.path === 'compose.txt' && file.status === 'corrupted'));
});

test('clock-bounded overhead stays bounded when client cohort membership is ambiguous', async t => {
  const lab = fixture(t, () => ({ clockWidth: 10n }));
  await lab.run(2);
  const report = lab.report();
  assert.ok(report.pairs[0].acceptedAttemptId);
  const measures = report.scenarios[0].measures;
  assert.equal(measures.failed_requests.numericPairs, 0);
  assert.equal(measures.deployment_overhead.numericPairs, 0);
  assert.equal(measures.deployment_overhead.boundedPairs, 1);
  const bounds = measures.deployment_overhead.examples[0].differenceBoundsNs;
  assert.ok(bounds[0] < 1e9 && bounds[1] > 1e9);
});

test('selected rehearsal arms retain provenance, safety holds and raw evidence without paired analysis', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'wp5-rehearsal-schema-fixture-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'rehearsal');
  const environment = { ...frozen, project: 'health-aware-workflow-comparison' };
  const manifest = generateRehearsalManifest({ sessionId: 'offline-schema-test', gitRevision, frozen: environment,
    arms: [{ scenario: 'S2', arm: 'C' }, { scenario: 'S3', arm: 'H' }, { scenario: 'S1', arm: 'H' }] });
  initializeCollection(root, manifest, { mode: 'rehearsal' });
  const evidenceRoot = join(root, 'rehearsal-evidence');
  mkdirSync(evidenceRoot);
  writeFileSync(join(root, 'compose.txt'), 'sanitized fixture compose');
  write(join(root, 'preflight.json'), { syntheticSchemaTest: true });
  const readOnly = openCollection(root);
  const collection = openCollection(root, { expectedMode: 'rehearsal' });
  assert.throws(() => openCollection(root, { expectedMode: 'formal' }), /expected mode/);
  assert.throws(() => initializeCollection(join(parent, 'formal'), manifest), /seed/);
  assert.throws(() => openCollection(root, { fixtureRunners: {} }), /Invalid collection mode/);
  assert.throws(() => initializeCollection(root, manifest, { mode: 'rehearsal' }), /EEXIST/);
  await assert.rejects(readOnly.runNext(), /Explicit rehearsal/);
  const formal = generateCollectionManifest({ seed: '01', gitRevision, frozen: environment });
  const formalRoot = join(parent, 'formal');
  initializeCollection(formalRoot, formal);
  assert.throws(() => openCollection(formalRoot, { expectedMode: 'rehearsal' }), /expected mode/);
  assert.throws(() => initializeCollection(join(parent, 'bad-plan'), { ...manifest,
    arms: [manifest.arms[0], manifest.arms[0]] }, { mode: 'rehearsal' }), /Invalid rehearsal manifest/);
  const formalIds = new Set(formal.pairs.flatMap(pair => pair.original.arms.map(arm => arm.trialId)));
  assert.ok(manifest.arms.every(trial => !formalIds.has(trial.trialId)));
  const [first, second, third] = manifest.arms;
  const pathFor = trial => join(evidenceRoot, trial.trialId);
  mkdirSync(pathFor(first));
  await assert.rejects(collection.runNext(), /already exists/);
  rmSync(pathFor(first), { recursive: true });

  // Replay records built by the offline fixture; never call the production runner.
  const event = (sequence, payload) => writeFileSync(join(root, 'ledger', String(sequence).padStart(6, '0') + '.json'),
    JSON.stringify({ sequence, mode: 'rehearsal', manifestHash: readOnly.inspect().manifestHash,
      recordedAt: '2026-11-25T00:00:00.000Z', ...payload }), { flag: 'wx' });
  const start = (sequence, trial) => event(sequence, { type: 'start', trial, evidencePath: pathFor(trial),
    host: hostname(), pid: process.pid });
  start(1, first);
  await assert.rejects(collection.runNext(), /interrupted_or_unresolved/);
  const outcome = syntheticTrial(first.scenario, { ...first, evidenceRoot, frozen: environment }, { failure: true });
  outcome.cleanup = { status: 'failed' };
  outcome.reset = { status: 'failed' };
  outcome.nextArmAllowed = false;
  const outcomeRef = join(pathFor(first), 'summary.json');
  write(outcomeRef, outcome);
  event(2, { type: 'outcome', trialId: first.trialId, startedAt: 1, outcomeRef, outcome });
  await assert.rejects(collection.runNext(), /reset_blocked/);
  assert.throws(() => collection.reconcile({ ...review, operationsSettled: true }), /verified reset/);
  collection.reconcile({ ...review, operationsSettled: true, resetVerified: true });
  assert.equal(collection.inspect().trial.trialId, second.trialId);
  start(4, second);
  collection.reconcile({ ...review, operationsSettled: true, resetVerified: true, aborted: true });
  assert.equal(collection.inspect().trial.trialId, third.trialId);
  assert.throws(() => collection.decidePair({ decision: 'replace' }), /not eligible/);
  const before = snap(root);
  const report = analyzeWorkflowCollection(root);
  assert.equal(report.provenance.mode, 'rehearsal');
  assert.deepEqual(report.pairs, []);
  assert.deepEqual(report.scenarios, []);
  assert.deepEqual(report.rehearsalArms.map(arm => arm.status), ['completed', 'aborted', 'planned']);
  assert.ok(report.rehearsalArms.every(arm => arm.provenance === 'rehearsal' && !arm.accepted));
  assert.equal(report.rehearsalArms[0].safety.nextArmAllowed, false);
  assert.equal(report.rehearsalArms[0].recordedOutcome, 'FAILED');
  assert.equal(report.audit.trials[0].clockVerified, true);
  const target = join(parent, 'report');
  writeWorkflowReports(report, target, { analysisGitRevision: gitRevision, analysisTimestamp: '2026-11-25T00:00:00.000Z' });
  assert.match(readFileSync(join(target, 'summary.md'), 'utf8'), /rehearsal — nonformal evidence/);
  assert.equal(read(join(target, 'rehearsal-arms.json')).mode, 'rehearsal');
  assert.ok(!readdirSync(target).includes('matched-pairs.json'));
  assert.deepEqual(snap(root), before);

  start(6, third);
  collection.reconcile({ ...review, operationsSettled: true, resetVerified: true, aborted: true });
  assert.equal(collection.inspect().status, 'collection_complete');
  await assert.rejects(collection.runNext(), /collection_complete/);

  write(join(root, 'manifest.json'), { mode: 'formal', manifest });
  assert.throws(() => openCollection(root), /seed/);
});
