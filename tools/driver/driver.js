import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
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
  notes: { type: 'string' },
  'notify-start': { type: 'boolean' }
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
  notes: values.notes ?? '',
  notifyStart: values['notify-start'] === true
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

function writeOutputFile(filePath, contents) {
  const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;

  try {
    fs.writeFileSync(tempPath, contents, { flag: 'wx' });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the publication error if temporary-file cleanup also fails.
    }
    throw error;
  }

  return filePath;
}

function writeRequestsCsv(config, observations) {
  const rows = [CSV_COLUMNS.join(',')];

  for (const record of observations) {
    const values = CSV_COLUMNS.map(column =>
      column === 'run_id'
        ? config.runId
        : record[column]
    );

    rows.push(values.map(csvField).join(','));
  }

  return writeOutputFile(
    path.join(config.runDir, 'requests.csv'),
    rows.join('\n') + '\n'
  );
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
  return writeOutputFile(
    path.join(config.runDir, 'run.json'),
    JSON.stringify(metadata, null, 2) + '\n'
  );
}

function writeRunOutputs(config, observations, metadata) {
  let step = 'create_run_directory';

  try {
    fs.mkdirSync(path.dirname(config.runDir), { recursive: true });
    fs.mkdirSync(config.runDir);

    step = 'write_requests_csv';
    writeRequestsCsv(config, observations);

    // Publish the run status after the CSV is in place.
    step = 'write_run_json';
    writeRunJson(config, metadata);
  } catch (error) {
    process.exitCode = 1;
    console.error(`Output failure (${step}): ${error.message}`);

    if (step === 'create_run_directory') return;

    try {
      const jsonPath = writeRunJson(config, {
        ...metadata,
        status: 'invalid',
        output_error: {
          step,
          code: error.code ?? null,
          message: error.message
        }
      });
      console.error(`Invalid run recorded at: ${jsonPath}`);
    } catch (metadataError) {
      console.error(`Could not persist invalid run status: ${metadataError.message}`);
    }
  }
}

// Enable with --notify-start and spawn the driver with a Node IPC channel.
function notifyStart(runId, clockStart) {
  const failed = error => console.error('Driver start notification failed: ' + error.message);
  if (!process.connected || typeof process.send !== 'function') {
    failed(new Error('No connected IPC channel'));
    return;
  }
  try {
    process.send({ event: 'driver_start', run_id: runId, clock_alignment: clockStart }, error => {
      if (error) failed(error);
    });
  } catch (error) {
    failed(error);
  }
}

async function scheduleRequests(config, {
  start, observations, pending, stopSignal, forceSignal, onFatal
}) {
  const periodMs = 1000 / config.rate;
  let inFlight = 0;

  for (let i = 0; i < config.offered; i++) {
    const scheduled = i * periodMs;
    const deadline = start + scheduled;

    while (!stopSignal.aborted && performance.now() < deadline) {
      const remainingMs = deadline - performance.now();

      try {
        await sleep(Math.max(1, Math.ceil(remainingMs)), undefined, {
          signal: stopSignal
        });
      } catch (error) {
        if (error.name !== 'AbortError' || !stopSignal.aborted) throw error;
      }
    }

    if (stopSignal.aborted) break;

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

    if (actual - deadline > config.maxLatenessMs) {
      record.outcome = 'missed';
      record.miss_reason = 'late';
      observations.push(record);
      continue;
    }

    if (inFlight >= config.maxConcurrency) {
      record.outcome = 'missed';
      record.miss_reason = 'concurrency';
      observations.push(record);
      continue;
    }

    record.dispatched_ms = actual - start;
    record.dispatch_delay_ms = record.dispatched_ms - scheduled;

    const abort = new AbortController();
    const requestSignal = AbortSignal.any([abort.signal, forceSignal]);
    const timer = setTimeout(() => abort.abort(), config.timeoutMs);

    observations.push(record);
    inFlight++;

    const task = (async () => {
      try {
        const response = await fetch(config.url, {
          redirect: 'manual',
          signal: requestSignal
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

        if (forceSignal.aborted && requestSignal.reason === forceSignal.reason) {
          record.outcome = 'interrupted';
        } else if (abort.signal.aborted) {
          record.outcome = 'timeout';
        } else if (NETWORK_ERROR_CODES.has(code)) {
          record.outcome = 'connection_error';
          record.error_code = code;
        } else {
          record.outcome = 'driver_error';
          record.error_code = code ?? error?.name ?? 'UNKNOWN';
        }

      } finally {
        clearTimeout(timer);
        inFlight--;

        if (record.outcome !== 'interrupted') {
          record.completed_ms = performance.now() - start;
          record.latency_ms = record.completed_ms - record.dispatched_ms;
        }
      }
    })().catch(error => {
      record.outcome = 'driver_error';
      record.error_code = error?.code ?? error?.name ?? 'UNKNOWN';
      onFatal(error);
    });

    pending.add(task);
    void task.then(() => pending.delete(task));
  }
}

async function runExperiment(config, stopSignal, forceSignal) {
  const observations = [];
  const pending = new Set();
  const fatalStop = new AbortController();
  const schedulingSignal = AbortSignal.any([stopSignal, fatalStop.signal]);

  let fatalError = null;
  function onFatal(error) {
    if (fatalError) return;
    fatalError = {
      code: error?.code ?? null,
      message: error?.message ?? String(error)
    };
    fatalStop.abort();
  }

  const context = collectRunContext();
  const wallStartMs = Date.now();
  const clockStartBeforeNs = process.hrtime.bigint();
  const start = performance.now();
  const clockStartAfterNs = process.hrtime.bigint();
  const clockStart = () => ({
    version: 1,
    source: 'process.hrtime.bigint',
    start_before_ns: clockStartBeforeNs.toString(),
    start_after_ns: clockStartAfterNs.toString()
  });
  if (config.notifyStart) notifyStart(config.runId, clockStart());

  try {
    await scheduleRequests(config, {
      start, observations, pending, stopSignal: schedulingSignal, forceSignal, onFatal
    });
  } catch (error) {
    onFatal(error);
  }
  await Promise.all(pending);
  const clockEndBeforeNs = process.hrtime.bigint();
  const clockEndMs = performance.now();
  const clockEndAfterNs = process.hrtime.bigint();

  if (fatalError) {
    process.exitCode = 1;
    console.error(`Fatal run error: ${fatalError.message}`);
  }

  const totals = Object.fromEntries(
    [
      'ok',
      'http_error',
      'timeout',
      'connection_error',
      'driver_error',
      'interrupted',
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
  const status = stopSignal.aborted || fatalError
    ? 'incomplete'
    : valid ? 'complete' : 'invalid';

  if (status === 'invalid') {
    process.exitCode = 1;
    console.error('Run accounting validation failed');
  }

  const metadata = {
    run_id: config.runId,
    status,

    wall_start_ms: wallStartMs,
    wall_start_iso: new Date(wallStartMs).toISOString(),

    clock_alignment: {
      ...clockStart(),
      end_before_ns: clockEndBeforeNs.toString(),
      end_after_ns: clockEndAfterNs.toString(),
      elapsed_ns: String(Math.round((clockEndMs - start) * 1e6))
    },
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
    review_required: Boolean(fatalError) || totals.driver_error > 0,
    ...(fatalError ? { fatal_error: fatalError } : {})
  };

  writeRunOutputs(config, observations, metadata);
  console.log(JSON.stringify(totals));
}

const stopScheduling = new AbortController();
const cancelRequests = new AbortController();

function onStop(signal) {
  if (stopScheduling.signal.aborted) {
    cancelRequests.abort();
    return;
  }

  process.exitCode = signal === 'SIGINT' ? 130 : 143;
  stopScheduling.abort();
}

process.on('SIGINT', onStop);
process.on('SIGTERM', onStop);

try {
  await runExperiment(config, stopScheduling.signal, cancelRequests.signal);
} finally {
  process.off('SIGINT', onStop);
  process.off('SIGTERM', onStop);
}
