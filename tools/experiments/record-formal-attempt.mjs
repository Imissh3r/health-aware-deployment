import { randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { classifyTrialEvidence } from './formal-trial-classifier.mjs';
import { readPublishedTrialBundle } from './formal-trial-bundle.mjs';

const schemaVersion = 1;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function syncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertOutsideBundle(bundle, destination) {
  const inside = relative(bundle, destination);
  if (!isAbsolute(inside) && inside !== '..' && !inside.startsWith('..' + sep)) {
    throw new Error('Attempt log must be outside the evidence bundle');
  }
}

function prepareLogDirectory(logPath, bundle) {
  const requested = resolve(logPath);
  assertOutsideBundle(bundle, requested);
  const parent = realpathSync(dirname(requested));
  const path = join(parent, basename(requested));
  assertOutsideBundle(bundle, path);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const directory = realpathSync(path);
  assertOutsideBundle(bundle, directory);
  if (!statSync(directory).isDirectory()) throw new Error('Attempt log must be a directory: ' + directory);
  syncDirectory(parent);
  return directory;
}

function existingRecord(path, payload) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return null;
  const malformed = () => new Error('Malformed existing attempt record; review manually: ' + path);
  if (!entry.isFile()) throw malformed();
  const text = readFileSync(path, 'utf8');
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw malformed();
  }
  const timestamp = Date.parse(record?.recorded_at);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== record.recorded_at) {
    throw malformed();
  }
  const { recorded_at: _, ...stored } = record;
  if (!isDeepStrictEqual(stored, payload)) {
    throw new Error('Existing attempt record conflicts with this bundle or its provenance; review manually: ' + path);
  }
  return record;
}

function publishAttempt(directory, path, payload) {
  const existing = existingRecord(path, payload);
  if (existing) {
    syncDirectory(directory);
    return { recording_status: 'already_recorded', record_path: path, record: existing };
  }

  const record = { ...payload, recorded_at: new Date().toISOString() };
  const temporary = join(directory, '.attempt-' + randomUUID() + '.tmp');
  const fd = openSync(temporary, 'wx', 0o600);
  let winner;
  try {
    try {
      writeFileSync(fd, JSON.stringify(record, null, 2) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, path);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      winner = existingRecord(path, payload);
      if (!winner) throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  syncDirectory(directory);
  return {
    recording_status: winner ? 'already_recorded' : 'recorded',
    record_path: path,
    record: winner ?? record
  };
}

export function recordFormalAttempt({ pairId, arm, bundlePath, logPath }) {
  if (typeof pairId !== 'string' || !idPattern.test(pairId)) throw new Error('Invalid pair ID');
  if (arm !== 'A' && arm !== 'B') throw new Error('Arm must be A or B');
  const { directory, trialId, evidence, artifacts } = readPublishedTrialBundle(bundlePath);
  if (!idPattern.test(trialId)) throw new Error('Invalid trial ID in bundle directory name');
  if (evidence.trial && (evidence.trial.trial_id !== trialId || evidence.trial.arm !== arm)) {
    throw new Error('Bundle trial ID or arm conflicts with the requested attempt');
  }
  if (evidence.trial?.preflight_only === true) throw new Error('Preflight-only evidence is not a trial attempt');
  const payload = {
    schema_version: schemaVersion,
    pair_id: pairId,
    arm,
    attempt_id: trialId,
    trial_id: trialId,
    evidence_location: directory,
    artifacts,
    classification: classifyTrialEvidence(evidence)
  };
  const logDirectory = prepareLogDirectory(logPath ?? join(dirname(directory), 'formal-attempts'), directory);
  return publishAttempt(logDirectory, join(logDirectory, trialId + '.json'), payload);
}

if (import.meta.main) {
  try {
    const { values, positionals } = parseArgs({
      options: {
        'pair-id': { type: 'string' },
        arm: { type: 'string' },
        'log-dir': { type: 'string' }
      },
      allowPositionals: true
    });
    if (positionals.length !== 1 || !values['pair-id'] || !values.arm) {
      throw new Error('Usage: node tools/experiments/record-formal-attempt.mjs --pair-id ID --arm A|B [--log-dir PATH] BUNDLE');
    }
    console.log(JSON.stringify(recordFormalAttempt({
      pairId: values['pair-id'], arm: values.arm, bundlePath: positionals[0], logPath: values['log-dir']
    }), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ recording_status: 'failed', error: error.message }));
    process.exitCode = 1;
  }
}
