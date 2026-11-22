import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

function parseCsv(text, requiredColumns) {
  const field = /("(?:[^"]|"")*"|[^,"\r\n]*)(,|\r\n|\n|\r|$)/y;
  const records = [];
  let row = [];
  let moreFields = false;
  while (field.lastIndex < text.length || moreFields) {
    const match = field.exec(text);
    if (!match) throw new SyntaxError('Invalid CSV field');
    const [, value, delimiter] = match;
    row.push(value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value);
    moreFields = delimiter === ',';
    if (!moreFields) {
      records.push(row);
      row = [];
    }
  }
  const [columns, ...rows] = records;
  if (!columns || new Set(columns).size !== columns.length ||
      !requiredColumns.every(column => columns.includes(column))) {
    throw new SyntaxError('Missing or duplicate CSV columns');
  }
  return rows.map(values => {
    if (values.length !== columns.length) throw new SyntaxError('Invalid CSV row width');
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  });
}

function numeric(value, column, optional = false) {
  if (value.trim() === '') {
    if (optional) return null;
    throw new SyntaxError('Missing numeric CSV field ' + column);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new SyntaxError('Invalid numeric CSV field ' + column);
  return parsed;
}

function parseRequests(text) {
  return parseCsv(text, ['run_id', 'seq', 'scheduled_ms', 'completed_ms', 'latency_ms', 'outcome', 'miss_reason'])
    .map(row => ({
      ...row,
      seq: numeric(row.seq, 'seq'),
      scheduled_ms: numeric(row.scheduled_ms, 'scheduled_ms'),
      completed_ms: numeric(row.completed_ms, 'completed_ms', row.outcome === 'missed'),
      latency_ms: numeric(row.latency_ms, 'latency_ms', row.outcome !== 'ok')
    }));
}

function parseEvents(text) {
  return parseCsv(text, ['trial_id', 'arm', 'event', 'wall_ms'])
    .map(row => ({ ...row, wall_ms: numeric(row.wall_ms, 'wall_ms') }));
}

function parseJsonObject(text, requiredFields) {
  const record = JSON.parse(text);
  if (record === null || typeof record !== 'object' || Array.isArray(record) ||
      requiredFields.some(field => typeof record[field] !== 'string' || record[field].trim() === '')) {
    throw new SyntaxError('Missing required JSON fields');
  }
  return record;
}

function parseJsonLines(text, validRecord, allowEmpty = true) {
  const records = text.split(/\r?\n/).filter(line => line.trim() !== '').map(line => JSON.parse(line));
  if ((!allowEmpty && records.length === 0) || !records.every(record => record && validRecord(record))) {
    throw new SyntaxError('Invalid JSONL record');
  }
  return records;
}

function readArtifact(directory, name, parse, malformed = null) {
  const path = join(directory, name);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return { value: null, artifact: { status: 'missing', sha256: null } };
  if (!entry.isFile()) throw new Error('Artifact must be a regular file: ' + path);
  const bytes = readFileSync(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    if (error.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw error;
    return { value: malformed, artifact: { status: 'malformed', sha256, detail: 'Invalid UTF-8' } };
  }
  try {
    return { value: parse(text), artifact: { status: 'present', sha256 } };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { value: malformed, artifact: { status: 'malformed', sha256, detail: error.message } };
  }
}

function checkStaging(directory) {
  if (directory.split(sep).includes('.staging') ||
      lstatSync(join(dirname(directory), '.staging', basename(directory)), { throwIfNoEntry: false })) {
    throw new Error('Trial bundle is still in staging: ' + directory);
  }
}

export function readPublishedTrialBundle(bundlePath) {
  const requested = resolve(bundlePath);
  checkStaging(requested);
  const directory = realpathSync(requested);
  checkStaging(directory);
  if (!statSync(directory).isDirectory()) throw new Error('Trial bundle must be a directory: ' + directory);

  const definitions = [
    ['trial', 'trial.json', text => parseJsonObject(text, ['trial_id', 'arm', 'event', 'completed_at'])],
    ['driver', 'run.json', text => parseJsonObject(text, ['run_id', 'status'])],
    ['requests', 'requests.csv', parseRequests],
    ['events', 'events.csv', parseEvents],
    ['controller', 'controller.jsonl', text => parseJsonLines(text, record =>
      typeof record.deployment_id === 'string' && typeof record.status === 'string' && record.status.trim() !== ''), [null]],
    ['clockSamples', 'clock-samples.jsonl', text => parseJsonLines(text, record =>
      Number.isSafeInteger(record.wall_ms) && record.wall_ms >= 0 &&
      Number.isFinite(record.monotonic_ms) && record.monotonic_ms >= 0, false), [null]]
  ];
  const evidence = {};
  const artifacts = {};
  for (const [key, name, parse, malformed] of definitions) {
    const artifact = readArtifact(directory, name, parse, malformed);
    evidence[key] = artifact.value;
    artifacts[name] = artifact.artifact;
  }
  checkStaging(directory);
  return { directory, trialId: basename(directory), evidence, artifacts };
}
