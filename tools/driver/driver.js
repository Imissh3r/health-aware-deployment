import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Default results location: <repo root>/experiments/results, whatever the
// current working directory is when the driver is started.
const DEFAULT_OUT = fileURLToPath(
  new URL('../../experiments/results', import.meta.url)
);

const REPO_ROOT = fileURLToPath(
  new URL('../../', import.meta.url)
);

// Sanity guard against typos, not an experimental threshold.
const MAX_OFFERED = 1_000_000;

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
]);

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

const CSV_COLUMNS = [
  'run_id',
  'seq',
  'scheduled_ms',
  'dispatched_ms',
  'completed_ms',
  'dispatch_delay_ms',
  'latency_ms',
  'outcome',
  'http_status',
  'error_code',
  'miss_reason',
  'version',
  'warmup'
];

function csvField(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function writeRequestsCsv(config, observations) {
  // The parent directory may need to be created.
  fs.mkdirSync(path.dirname(config.runDir), {
    recursive: true
  });

  // Exclusive creation: fail if this run directory already exists.
  fs.mkdirSync(config.runDir);

  const rows = [CSV_COLUMNS.join(',')];

  for (const record of observations) {
    const values = CSV_COLUMNS.map(column =>
      column === 'run_id'
        ? config.runId
        : record[column]
    );

    rows.push(values.map(csvField).join(','));
  }

  const csvPath = path.join(config.runDir, 'requests.csv');

  fs.writeFileSync(
    csvPath,
    rows.join('\n') + '\n',
    { flag: 'wx' }
  );

  return csvPath;
}

function collectRunContext() {
  const packageJson = JSON.parse(
    fs.readFileSync(
      new URL('./package.json', import.meta.url),
      'utf8'
    )
  );

  function gitCommand(...args) {
    return execFileSync('git', ['-C', REPO_ROOT, ...args], {
      encoding: 'utf8',
      timeout: 5000
    }).trim();
  }

  const gitCommit = gitCommand('rev-parse', 'HEAD');

  const gitStatus = gitCommand(
    'status',
    '--porcelain',
    '--',
    '.',
    ':(exclude)experiments/results'
  );

  return {
    driver_version: packageJson.version,
    node_version: process.version,

    host: {
      platform: os.platform(),
      architecture: os.arch(),
      cpu_count: os.cpus().length,
      total_memory_bytes: os.totalmem()
    },

    git: {
      commit: gitCommit,
      working_tree: gitStatus === '' ? 'clean' : 'dirty'
    },

    http_client: {
      implementation: 'Node.js built-in fetch',
      keep_alive_setting: 'default',
      connection_reuse: 'Default fetch behaviour; not measured per request'
    }
  };
}

function writeRunJson(config, metadata) {
  const jsonPath = path.join(config.runDir, 'run.json');

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(metadata, null, 2) + '\n',
    { flag: 'wx' }
  );

  return jsonPath;
}

// Stage 3.2 prototype: in-memory observations only; no output files yet.
async function runPrototype(config) {
  const periodMs = 1000 / config.rate;
  const observations = new Array(config.offered);
  const pending = new Set();

  let inFlight = 0;

  // Collect environment information before measurement begins.
  const context = collectRunContext();

  // Capture the wall-clock and monotonic origins together.
  const wallStartMs = Date.now();
  const start = performance.now();

  for (let i = 0; i < config.offered; i++) {
    const scheduled = i * periodMs;
    const deadline = start + scheduled;

    while (performance.now() < deadline) {
      const remainingMs = deadline - performance.now();

      await new Promise(resolve =>
        setTimeout(resolve, Math.max(1, Math.ceil(remainingMs)))
      );
    }

    const actual = performance.now();

    const record = {
      seq: i + 1,
      scheduled_ms: scheduled,
      dispatched_ms: null,
      completed_ms: null,
      dispatch_delay_ms: null,
      latency_ms: null,
      outcome: null,
      http_status: null,
      error_code: null,
      miss_reason: null,
      version: null,
      warmup: scheduled < config.warmupSeconds * 1000
    };

    observations[i] = record;

    if (actual - deadline > config.maxLatenessMs) {
      record.outcome = 'missed';
      record.miss_reason = 'late';
      continue;
    }

    if (inFlight >= config.maxConcurrency) {
      record.outcome = 'missed';
      record.miss_reason = 'concurrency';
      continue;
    }

    record.dispatched_ms = actual - start;
    record.dispatch_delay_ms = record.dispatched_ms - scheduled;

    inFlight++;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.timeoutMs);

    const task = (async () => {
      try {
        const response = await fetch(config.url, {
          redirect: 'manual',
          signal: abort.signal
        });

        record.http_status = response.status;

        const body = await response.text();

        record.outcome =
          response.status >= 200 && response.status < 300
            ? 'ok'
            : 'http_error';

        try {
          const parsed = JSON.parse(body);

          if (typeof parsed?.version === 'string') {
            record.version = parsed.version;
          }
        } catch {
          // Not JSON is allowed; version remains null.
        }

      } catch (error) {
        const code = error?.cause?.code ?? error?.code;

        if (abort.signal.aborted) {
          record.outcome = 'timeout';
        } else if (NETWORK_ERROR_CODES.has(code)) {
          record.outcome = 'connection_error';
          record.error_code = code;
        } else {
          record.outcome = 'driver_error';
          record.error_code = code ?? error?.name ?? 'UNKNOWN';
        }

      } finally {
        record.completed_ms = performance.now() - start;
        record.latency_ms =
          record.completed_ms - record.dispatched_ms;

        clearTimeout(timer);
        inFlight--;
      }
    })();

    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  await Promise.all(pending);

  const totals = Object.fromEntries(
    [
      'ok',
      'http_error',
      'timeout',
      'connection_error',
      'driver_error',
      'missed'
    ].map(outcome => [
      outcome,
      observations.filter(r => r.outcome === outcome).length
    ])
  );

  const missed = totals.missed;
  const dispatched = observations.length - missed;

  const settled =
    totals.ok +
    totals.http_error +
    totals.timeout +
    totals.connection_error +
    totals.driver_error;

  const missedByReason = {
    late: observations.filter(r => r.miss_reason === 'late').length,
    concurrency: observations.filter(
      r => r.miss_reason === 'concurrency'
    ).length
  };

  console.log(JSON.stringify({
    prototype: true,
    offered: observations.length,
    dispatched,
    settled,
    missed,
    missedByReason,
    totals,
    firstFive: observations.slice(0, 5)
  }, null, 2));


  const invariants = {
    offered_accounted:
      config.offered === dispatched + missed,

    dispatched_settled:
      dispatched === settled,

    record_count_and_sequence:
      observations.length === config.offered &&
      Array.from(observations).every(
        (record, index) => record?.seq === index + 1
      ),

    missed_reasons_accounted:
      missedByReason.late + missedByReason.concurrency === missed
  };

  const valid = Object.values(invariants).every(Boolean);
  const status = valid ? 'complete' : 'invalid';

  if (!valid) {
    process.exitCode = 1;
    console.error('Run accounting validation failed');
  }

  const metadata = {
    run_id: config.runId,
    status,

    wall_start_ms: wallStartMs,
    wall_start_iso: new Date(wallStartMs).toISOString(),

    target_url: config.url,

    options: {
      rate: config.rate,
      duration_seconds: config.duration,
      timeout_ms: config.timeoutMs,
      max_concurrency: config.maxConcurrency,
      max_lateness_ms: config.maxLatenessMs,
      warmup_seconds: config.warmupSeconds,
      run_id: config.runId,
      out: path.dirname(config.runDir),
      notes: config.notes
    },

    ...context,

    summary: {
      offered: config.offered,
      dispatched,
      settled,
      missed,
      missed_by_reason: missedByReason,
      outcomes: totals
    },

    invariants,
    review_required: totals.driver_error > 0
  };

  const csvPath = writeRequestsCsv(config, observations);
  const jsonPath = writeRunJson(config, metadata);

  console.log(`Request records written to: ${csvPath}`);
  console.log(`Run metadata written to: ${jsonPath}`);

}

await runPrototype(config);