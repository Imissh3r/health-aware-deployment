import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Default results location: <repo root>/experiments/results, whatever the
// current working directory is when the driver is started.
const DEFAULT_OUT = fileURLToPath(
  new URL('../../experiments/results', import.meta.url)
);

// Sanity guard against typos, not an experimental threshold.
const MAX_OFFERED = 1_000_000;

const OPTIONS = {
  url: { type: 'string' },
  rate: { type: 'string' },
  duration: { type: 'string' },
  timeout: { type: 'string' },
  'max-concurrency': { type: 'string' },
  'max-lateness': { type: 'string' },
  warmup: { type: 'string' },
  'run-id': { type: 'string' },
  out: { type: 'string' },
  notes: { type: 'string' }
};

function fail(messages) {
  console.error('Invalid configuration, nothing was started:');
  for (const message of messages) console.error(`  - ${message}`);
  process.exit(1);
}

function positiveInt(name, raw, fallback, errors) {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    errors.push(`--${name} must be a positive integer (got "${raw}")`);
    return undefined;
  }
  return Number(raw);
}

function nonNegativeInt(name, raw, fallback, errors) {
  if (raw === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    errors.push(`--${name} must be a non-negative integer (got "${raw}")`);
    return undefined;
  }
  return Number(raw);
}

function positiveNumber(name, raw, fallback, errors) {
  if (raw === undefined) return fallback;
  const number = Number(raw);
  if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(number) || number <= 0) {
    errors.push(`--${name} must be a positive number (got "${raw}")`);
    return undefined;
  }
  return number;
}

function defaultRunId() {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '-');
  return `run-${stamp}-${randomBytes(2).toString('hex')}`;
}

let values;
let tokens;
try {
  ({ values, tokens } = parseArgs({
    options: OPTIONS,
    allowPositionals: false,
    strict: true,
    tokens: true
  }));
} catch (error) {
  fail([error.message]);
}

const errors = [];

// parseArgs silently keeps the last value of a repeated option; reject it.
const seen = new Set();
for (const token of tokens) {
  if (token.kind !== 'option') continue;
  if (seen.has(token.name)) {
    errors.push(`--${token.name} was provided more than once`);
  }
  seen.add(token.name);
}

let url;
if (values.url === undefined) {
  errors.push('--url is required');
} else {
  try {
    url = new URL(values.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`--url must use http or https (got "${values.url}")`);
    }
  } catch {
    errors.push(`--url is not a valid URL (got "${values.url}")`);
  }
}

const rate = positiveInt('rate', values.rate, 5, errors);
const duration = positiveInt('duration', values.duration, 60, errors);

const offered =
  rate === undefined || duration === undefined ? undefined : rate * duration;
if (
  offered !== undefined &&
  (!Number.isSafeInteger(offered) || offered > MAX_OFFERED)
) {
  errors.push(
    `--rate x --duration (${offered}) must be a safe integer of at most ${MAX_OFFERED}`
  );
}

const timeoutMs = positiveInt('timeout', values.timeout, 3000, errors);
const maxConcurrency = positiveInt(
  'max-concurrency',
  values['max-concurrency'],
  50,
  errors
);
const maxLateness = positiveNumber(
  'max-lateness',
  values['max-lateness'],
  rate === undefined ? undefined : 1000 / rate,
  errors
);

const warmup = nonNegativeInt('warmup', values.warmup, 5, errors);
if (warmup !== undefined && duration !== undefined && warmup >= duration) {
  errors.push(
    `--warmup (${warmup}) must be less than --duration (${duration}); ` +
    'set --warmup explicitly for short runs'
  );
}

const runId = values['run-id'] ?? defaultRunId();
const runIdValid =
  /^[A-Za-z0-9._-]+$/.test(runId) && runId !== '.' && runId !== '..';
if (!runIdValid) {
  errors.push(
    `--run-id may only contain letters, digits, dot, dash and underscore (got "${runId}")`
  );
}

let outDir = DEFAULT_OUT;
if (values.out !== undefined) {
  if (values.out.trim() === '') errors.push('--out must not be empty');
  else outDir = path.resolve(values.out);
}
const runDir = path.join(outDir, runId);
if (runIdValid && fs.existsSync(runDir)) {
  errors.push(`run directory already exists, refusing to overwrite: ${runDir}`);
}

if (errors.length > 0) fail(errors);

const config = {
  url: url.href,
  rate,
  duration,
  offered,
  timeoutMs,
  maxConcurrency,
  maxLatenessMs: maxLateness,
  warmupSeconds: warmup,
  runId,
  runDir,
  notes: values.notes ?? ''
};

console.log('Configuration is valid:');
console.log(JSON.stringify(config, null, 2));
console.log('(Skeleton only: nothing was sent and no files were written.)');