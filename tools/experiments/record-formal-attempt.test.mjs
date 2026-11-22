import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { classifyTrialEvidence } from './formal-trial-classifier.mjs';
import { recordFormalAttempt } from './record-formal-attempt.mjs';

const cli = fileURLToPath(new URL('./record-formal-attempt.mjs', import.meta.url));
const pairId = 'pair-01';
const arm = 'A';
const start = 1_795_167_069_023;
const cleanup = start + 61_000;
const verifiedAt = start + 22_000;
const deploymentId = 'deployment-01';

function csv(rows) {
  const columns = Object.keys(rows[0]);
  function field(value) {
    const text = String(value ?? '');
    return /[,"\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  }
  return [columns.join(','), ...rows.map(row => columns.map(column => field(row[column])).join(','))].join('\r\n') + '\r\n';
}

function writeBundle(bundlePath, trialId) {
  mkdirSync(bundlePath, { recursive: true });
  const checks = {
    routing_state: { deployment_id: null, pending_deployment_id: null },
    config_upstreams: ['http://app:3000'],
    services: Object.fromEntries(['db', 'app', 'candidate', 'nginx'].map(name =>
      [name, [{ state: 'running', health: name === 'nginx' ? null : 'healthy' }]])),
    candidate_fault_flag: 'absent',
    proxy: { http_status: 200, version: '1.0.0' }
  };
  const trial = {
    event: 'paired_pilot', trial_id: trialId, arm, deployment_id: deploymentId, checks,
    preflight_only: false, failures: [], status: 'TRIAL_PASSED', completed_at: new Date(cleanup + 100).toISOString(),
    observation: {
      cutoff_ms: start + 60_000, cleanup_started_ms: cleanup,
      verified_at_ms: verifiedAt, recovery_verified_in_window: true
    }
  };
  const driver = {
    run_id: trialId, status: 'complete', wall_start_ms: start,
    target_url: 'http://127.0.0.1:8080/api/work', review_required: false,
    options: { rate: 5, duration_seconds: 60, warmup_seconds: 5, timeout_ms: 3000,
      max_concurrency: 50, max_lateness_ms: 200 },
    summary: {
      offered: 300, dispatched: 300, settled: 300, missed: 0,
      missed_by_reason: { late: 0, concurrency: 0 },
      outcomes: { ok: 300, http_error: 0, timeout: 0, connection_error: 0, driver_error: 0, interrupted: 0, missed: 0 }
    },
    invariants: { offered_accounted: true, dispatched_settled: true, record_count_and_sequence: true,
      missed_reasons_accounted: true }
  };
  const requests = Array.from({ length: 300 }, (_, index) => ({
    run_id: trialId, seq: index + 1, scheduled_ms: index * 200, completed_ms: index * 200 + 7,
    latency_ms: 5, outcome: 'ok', miss_reason: '', error_code: index === 0 ? 'fixture, with "quoted" text\nand a newline' : ''
  }));
  const events = [
    ['promotion_verified', start - 12], ['driver_started', start],
    ['fault_activated', start + 15_000], ['recovery_verified', verifiedAt]
  ].map(([event, wall_ms]) => ({ trial_id: trialId, arm, event, wall_ms, source: 'runner' }));
  const controller = [{
    status: 'ROLLED_BACK',
    deployment_id: deploymentId,
    recovery: {
      verified_at: new Date(verifiedAt).toISOString(), proxy_verified: true,
      verification: { passed: true, consecutive: 3 },
      last_proxy_observation: { http_status: 200, version: '1.0.0' }
    }
  }];
  const clockSamples = Array.from({ length: 245 }, (_, index) => ({
    wall_ms: start + 250 * index, monotonic_ms: 10.125 + 250 * index
  }));
  const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
  const files = {
    'trial.json': JSON.stringify(trial), 'run.json': JSON.stringify(driver),
    'requests.csv': csv(requests), 'events.csv': csv(events),
    'controller.jsonl': jsonl(controller), 'clock-samples.jsonl': jsonl(clockSamples)
  };
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(bundlePath, name), contents);
  return { trial, driver, requests, events, controller, clockSamples };
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'formal-attempt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const trialId = 'trial-01';
  const bundlePath = join(root, trialId);
  const evidence = writeBundle(bundlePath, trialId);
  const logPath = join(root, 'formal-attempts');
  const recordPath = join(logPath, trialId + '.json');
  return {
    root, trialId, evidence, bundlePath, logPath, recordPath,
    options: { pairId, arm, bundlePath },
    args: ['--pair-id', pairId, '--arm', arm, bundlePath]
  };
}

function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
}

test('records and reads back the full V1 classification and exact bundle digests', t => {
  const lab = setup(t);
  const original = snapshot(lab.bundlePath);
  const result = spawnSync(process.execPath, [cli, ...lab.args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const stored = JSON.parse(readFileSync(lab.recordPath, 'utf8'));
  assert.deepEqual(JSON.parse(result.stdout), { recording_status: 'recorded', record_path: lab.recordPath, record: stored });
  const { classification, artifacts, recorded_at, ...provenance } = stored;
  assert.deepEqual(provenance, {
    schema_version: 1, pair_id: pairId, arm, attempt_id: lab.trialId, trial_id: lab.trialId,
    evidence_location: lab.bundlePath
  });
  assert.equal(new Date(recorded_at).toISOString(), recorded_at);
  assert.deepEqual(classification, classifyTrialEvidence(lab.evidence));
  assert.equal(classification.cutoffOutcome.status, 'recovered_in_window');
  assert.deepEqual(Object.keys(artifacts).sort(), Object.keys(original).sort());
  for (const [name, bytes] of Object.entries(original)) {
    assert.deepEqual(artifacts[name], { status: 'present', sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  assert.deepEqual(snapshot(lab.bundlePath), original);
});

for (const [description, edit, artifactStatus, clockStatus, reason] of [
  ['partial', path => {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
    writeFileSync(path, lines.slice(0, -1).join('\n') + '\n');
  }, 'present', 'invalid', 'CLOCK_BRACKET_MISSING'],
  ['missing', path => rmSync(path), 'missing', 'not_collected', 'CLOCK_TRACE_MISSING'],
  ['malformed', path => writeFileSync(path, '{"wall_ms":\n'), 'malformed', 'invalid', 'CLOCK_SAMPLE_INVALID'],
  ['empty', path => writeFileSync(path, ''), 'malformed', 'invalid', 'CLOCK_SAMPLE_INVALID']
]) {
  test('records an unknown cutoff with ' + description + ' clock evidence', t => {
    const lab = setup(t);
    const name = 'clock-samples.jsonl';
    edit(join(lab.bundlePath, name));
    const original = snapshot(lab.bundlePath);
    const result = recordFormalAttempt(lab.options);
    assert.equal(result.recording_status, 'recorded');
    assert.equal(result.record.artifacts[name].status, artifactStatus);
    assert.equal(result.record.artifacts[name].sha256, original[name]
      ? createHash('sha256').update(original[name]).digest('hex') : null);
    assert.equal(result.record.classification.attemptValidity.status, 'valid');
    assert.equal(result.record.classification.workloadUsability.status, 'usable');
    assert.equal(result.record.classification.clockIntegrity.status, clockStatus);
    assert.deepEqual(result.record.classification.cutoffOutcome, { status: 'unknown', reasonCodes: [reason] });
    assert.deepEqual(snapshot(lab.bundlePath), original);
  });
}

test('preserves missing metadata and malformed controller and request artifacts independently', t => {
  const lab = setup(t);
  rmSync(join(lab.bundlePath, 'trial.json'));
  writeFileSync(join(lab.bundlePath, 'controller.jsonl'), 'null\n');
  writeFileSync(join(lab.bundlePath, 'requests.csv'), '"unterminated\n');
  const { record } = recordFormalAttempt(lab.options);
  assert.equal(record.trial_id, lab.trialId);
  assert.deepEqual(record.artifacts['trial.json'], { status: 'missing', sha256: null });
  for (const name of ['controller.jsonl', 'requests.csv']) {
    const digest = createHash('sha256').update(readFileSync(join(lab.bundlePath, name))).digest('hex');
    assert.equal(record.artifacts[name].sha256, digest);
    assert.equal(record.artifacts[name].status, 'malformed');
    assert.ok(record.artifacts[name].detail);
  }
  assert.equal(record.classification.attemptValidity.status, 'invalid');
  assert.equal(record.classification.workloadUsability.status, 'unusable');
  assert.equal(record.classification.recoveryEvidence.status, 'untrusted');
});

test('an identical submission returns the original record and a retry appends a separate attempt', t => {
  const lab = setup(t);
  const first = recordFormalAttempt(lab.options);
  const original = readFileSync(first.record_path);
  assert.deepEqual(recordFormalAttempt(lab.options), { ...first, recording_status: 'already_recorded' });
  const retry = join(lab.root, 'trial-02');
  writeBundle(retry, 'trial-02');
  const second = recordFormalAttempt({ ...lab.options, bundlePath: retry });
  assert.equal(second.recording_status, 'recorded');
  assert.equal(second.record.pair_id, first.record.pair_id);
  assert.equal(second.record.arm, first.record.arm);
  assert.notEqual(second.record.attempt_id, first.record.attempt_id);
  assert.deepEqual(readFileSync(first.record_path), original);
  assert.deepEqual(readdirSync(lab.logPath).sort(), ['trial-01.json', 'trial-02.json']);
});

test('different provenance or bytes conflict without replacing any record', t => {
  const lab = setup(t);
  recordFormalAttempt(lab.options);
  const original = readFileSync(lab.recordPath);
  assert.throws(() => recordFormalAttempt({ ...lab.options, pairId: 'another-pair' }), /conflicts/);
  assert.throws(() => recordFormalAttempt({ ...lab.options, arm: 'B' }), /arm conflicts/);
  const moved = join(lab.root, 'elsewhere', lab.trialId);
  cpSync(lab.bundlePath, moved, { recursive: true });
  assert.throws(() => recordFormalAttempt({ ...lab.options, bundlePath: moved, logPath: lab.logPath }), /conflicts/);
  const trace = join(lab.bundlePath, 'clock-samples.jsonl');
  writeFileSync(trace, readFileSync(trace, 'utf8') + '\n');
  assert.throws(() => recordFormalAttempt(lab.options), /conflicts/);
  assert.deepEqual(readFileSync(lab.recordPath), original);
});

test('rejects direct or aliased staging bundles and results with outstanding staging directories', t => {
  const lab = setup(t);
  const staged = join(lab.root, '.staging', lab.trialId);
  cpSync(lab.bundlePath, staged, { recursive: true });
  const alias = join(lab.root, 'alias');
  symlinkSync(staged, alias, 'dir');
  for (const bundlePath of [staged, alias, lab.bundlePath]) {
    assert.throws(() => recordFormalAttempt({ ...lab.options, bundlePath }), /still in staging/);
  }
  assert.equal(existsSync(lab.logPath), false);
});

test('refuses to create or place the log inside the evidence bundle', t => {
  const lab = setup(t);
  const original = snapshot(lab.bundlePath);
  const alias = join(lab.root, 'alias');
  symlinkSync(lab.bundlePath, alias, 'dir');
  for (const location of [lab.bundlePath, alias]) {
    assert.throws(() => recordFormalAttempt({ ...lab.options, logPath: join(location, 'attempts') }), /outside/);
  }
  assert.deepEqual(snapshot(lab.bundlePath), original);
});

test('requires manual review for a malformed existing attempt record', t => {
  const lab = setup(t);
  mkdirSync(lab.logPath);
  writeFileSync(lab.recordPath, '{"partial":');
  assert.throws(() => recordFormalAttempt(lab.options), /Malformed existing attempt record/);
  assert.equal(readFileSync(lab.recordPath, 'utf8'), '{"partial":');
});

test('concurrent submissions publish one file and return the same record', async t => {
  const lab = setup(t);
  const exec = promisify(execFile);
  const submissions = await Promise.all([
    exec(process.execPath, [cli, ...lab.args]),
    exec(process.execPath, [cli, ...lab.args])
  ]);
  const [first, second] = submissions.map(({ stdout }) => JSON.parse(stdout));
  assert.deepEqual([first.recording_status, second.recording_status].sort(), ['already_recorded', 'recorded']);
  assert.deepEqual(first.record, second.record);
  assert.deepEqual(readdirSync(lab.logPath), [lab.trialId + '.json']);
});

for (const stage of ['open', 'write', 'file-sync', 'link', 'directory-sync']) {
  test('preserves and recovers evidence after a ' + stage + ' publication failure', t => {
    const lab = setup(t);
    const original = snapshot(lab.bundlePath);
    const setupFault = join(lab.root, 'write-fault.mjs');
    writeFileSync(setupFault, [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "const { openSync, writeFileSync, fsyncSync, linkSync, fstatSync } = fs;",
      "const stage = process.env.RECORD_FAULT;",
      "const fail = () => { throw new Error('Injected failure: ' + stage); };",
      "fs.openSync = (path, ...args) => {",
      "  if (stage === 'open' && String(path).endsWith('.tmp')) fail();",
      "  return openSync(path, ...args);",
      "};",
      "fs.writeFileSync = (fd, ...args) => {",
      "  if (stage === 'write' && typeof fd === 'number') { writeFileSync(fd, '{'); fail(); }",
      "  return writeFileSync(fd, ...args);",
      "};",
      "fs.fsyncSync = fd => {",
      "  if (stage === 'file-sync' && fstatSync(fd).isFile()) fail();",
      "  if (stage === 'directory-sync' && fstatSync(fd).isDirectory() &&",
      "      fs.existsSync(process.env.RECORD_DESTINATION)) fail();",
      "  return fsyncSync(fd);",
      "};",
      "fs.linkSync = (...args) => {",
      "  if (stage === 'link') fail();",
      "  return linkSync(...args);",
      "};",
      "syncBuiltinESMExports();"
    ].join('\n'));
    const result = spawnSync(process.execPath, ['--import', setupFault, cli, ...lab.args], {
      encoding: 'utf8', env: { ...process.env, RECORD_FAULT: stage, RECORD_DESTINATION: lab.recordPath }
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { recording_status: 'failed', error: 'Injected failure: ' + stage });
    assert.deepEqual(snapshot(lab.bundlePath), original);
    const linked = stage === 'directory-sync';
    assert.deepEqual(readdirSync(lab.logPath), linked ? [lab.trialId + '.json'] : []);
    const linkedRecord = linked ? JSON.parse(readFileSync(lab.recordPath, 'utf8')) : null;
    const retry = recordFormalAttempt(lab.options);
    assert.equal(retry.recording_status, linked ? 'already_recorded' : 'recorded');
    if (linked) assert.deepEqual(retry.record, linkedRecord);
    assert.deepEqual(retry.record.classification, classifyTrialEvidence(lab.evidence));
    assert.deepEqual(snapshot(lab.bundlePath), original);
  });
}
