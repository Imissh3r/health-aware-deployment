import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const windowStartMs = 15_000;
const windowEndMs = 60_000;
const outcomes = ['ok', 'http_error', 'timeout', 'connection_error', 'driver_error', 'interrupted', 'missed'];
const invariantNames = ['offered_accounted', 'dispatched_settled', 'record_count_and_sequence',
  'missed_reasons_accounted'];
const optionNames = ['rate', 'duration_seconds', 'warmup_seconds', 'timeout_ms', 'max_concurrency', 'max_lateness_ms'];

function requireEvidence(condition, reason) {
  if (!condition) throw new Error(reason);
}

function readCsv(directory, file, requiredColumns) {
  const text = readFileSync(join(directory, file), 'utf8');
  const field = /("(?:[^"]|"")*"|[^,"\r\n]*)(,|\r\n|\n|\r|$)/y;
  const records = [];
  let row = [];
  let moreFields = false;
  while (field.lastIndex < text.length || moreFields) {
    const match = field.exec(text);
    requireEvidence(match, 'Malformed CSV in ' + file);
    const [, value, delimiter] = match;
    row.push(value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value);
    moreFields = delimiter === ',';
    if (!moreFields) {
      records.push(row);
      row = [];
    }
  }

  const [columns, ...rows] = records;
  requireEvidence(columns && new Set(columns).size === columns.length &&
    requiredColumns.every(column => columns.includes(column)), 'Missing or duplicate columns in ' + file);
  return rows.map((values, index) => {
    requireEvidence(values.length === columns.length, 'Wrong field count in ' + file + ' record ' + (index + 2));
    return Object.fromEntries(columns.map((column, position) => [column, values[position]]));
  });
}

function numericField(value, name) {
  const number = Number(value);
  requireEvidence(value.trim() !== '' && Number.isFinite(number) && number >= 0, 'Invalid ' + name);
  return number;
}

function settingsFrom(run) {
  const settings = Object.fromEntries(optionNames.map(name => [name, run.options?.[name]]));
  settings.target_url = run.target_url;
  for (const key of optionNames) {
    const value = settings[key];
    requireEvidence(Number.isFinite(value) && value >= 0, 'Invalid driver setting ' + key);
  }
  requireEvidence(Number.isSafeInteger(settings.rate) && settings.rate > 0 &&
    Number.isSafeInteger(settings.duration_seconds) && settings.duration_seconds * 1000 >= windowEndMs &&
    settings.warmup_seconds * 1000 <= windowStartMs &&
    typeof settings.target_url === 'string' && settings.target_url.length > 0,
  'The driver settings do not cover the fixed measurement window');
  return settings;
}

function requestMeasurements(directory, run, settings) {
  const rows = readCsv(directory, 'requests.csv', ['run_id', 'seq', 'scheduled_ms', 'completed_ms', 'latency_ms',
    'outcome', 'miss_reason']);
  const totals = Object.fromEntries(outcomes.map(name => [name, 0]));
  const window = { ...totals };
  const missedByReason = { late: 0, concurrency: 0 };
  const latency = [];
  let lastRequestMs = 0;
  const expected = settings.rate * settings.duration_seconds;
  requireEvidence(Number.isSafeInteger(expected) && rows.length === expected,
    'Request row count does not match rate × duration');

  const periodMs = 1000 / settings.rate;
  for (const [index, row] of rows.entries()) {
    const scheduled = numericField(row.scheduled_ms, 'scheduled_ms');
    requireEvidence(row.run_id === run.run_id && Number(row.seq) === index + 1 &&
      Math.abs(scheduled - index * periodMs) < 1e-6, 'Request identity or schedule mismatch at row ' + (index + 1));
    requireEvidence(Object.hasOwn(totals, row.outcome), 'Unknown request outcome ' + row.outcome);
    totals[row.outcome]++;
    lastRequestMs = Math.max(lastRequestMs, scheduled);
    if (row.outcome === 'missed') {
      requireEvidence(Object.hasOwn(missedByReason, row.miss_reason), 'Unknown missed-request reason');
      missedByReason[row.miss_reason]++;
    } else {
      lastRequestMs = Math.max(lastRequestMs, numericField(row.completed_ms, 'completed_ms'));
    }
    if (scheduled >= windowStartMs && scheduled < windowEndMs) {
      window[row.outcome]++;
      if (row.outcome === 'ok') latency.push(numericField(row.latency_ms, 'successful request latency'));
    }
  }

  const fullDispatched = rows.length - totals.missed;
  requireEvidence(run.summary?.offered === rows.length && run.summary.dispatched === fullDispatched &&
    run.summary.settled === fullDispatched && run.summary.missed === totals.missed &&
    outcomes.every(name => run.summary.outcomes?.[name] === totals[name]) &&
    Object.keys(missedByReason).every(reason => run.summary.missed_by_reason?.[reason] === missedByReason[reason]) &&
    totals.driver_error === 0 && totals.interrupted === 0, 'Driver summary does not agree with request accounting');

  const scheduled = Object.values(window).reduce((sum, count) => sum + count, 0);
  const dispatched = scheduled - window.missed;
  latency.sort((a, b) => a - b);
  const percentile = fraction => latency.length ? latency[Math.ceil(fraction * latency.length) - 1] : null;
  return {
    lastRequestMs,
    requests: {
      scheduled,
      dispatched,
      outcomes: window,
      success_rate: dispatched ? window.ok / dispatched : null,
      http_error_rate: dispatched ? window.http_error / dispatched : null,
      successful_latency_ms: { samples: latency.length, p50: percentile(0.50), p95: percentile(0.95) }
    }
  };
}

function recoveryMeasurements(directory, trial, run, lastRequestMs) {
  const rows = readCsv(directory, 'events.csv', ['trial_id', 'arm', 'event', 'wall_ms', 'source']);
  const events = Object.create(null);
  const reset = [];
  for (const row of rows) {
    requireEvidence(row.trial_id === trial.trial_id && row.arm === trial.arm, 'Event identity does not match the trial');
    const wall = numericField(row.wall_ms, 'event wall_ms');
    requireEvidence(Number.isSafeInteger(wall), 'Event wall_ms must be an integer');
    if (row.event === 'reset_verified') {
      reset.push(wall);
    } else {
      requireEvidence(!Object.hasOwn(events, row.event), 'Duplicate event ' + row.event);
      events[row.event] = wall;
    }
  }

  const required = ['trial_start', 'promotion_verified', 'driver_spawned', 'driver_started',
    'fault_activation_started', 'fault_activated', 'first_failure_probe', 'failure_confirmed',
    'rollback_started', 'recovery_verified', 'fault_cleared'];
  if (trial.arm === 'B') required.push('rollback_reconfirmed');
  const durationMs = run.options.duration_seconds * 1000;
  const start = run.wall_start_ms;
  requireEvidence(required.every(name => Object.hasOwn(events, name)) && reset.length === 2 &&
    Number.isSafeInteger(start) && start === events.driver_started, 'Missing or misaligned trial event markers');
  requireEvidence(events.trial_start <= reset[0] && reset[0] <= events.promotion_verified &&
    events.promotion_verified <= start && events.promotion_verified <= events.driver_spawned &&
    events.driver_spawned <= events.fault_activation_started && start <= events.fault_activation_started &&
    events.fault_activation_started <= events.fault_activated &&
    events.fault_activation_started <= events.first_failure_probe &&
    events.first_failure_probe <= events.failure_confirmed && events.failure_confirmed <= events.rollback_started &&
    events.rollback_started <= events.recovery_verified && events.fault_activated <= events.recovery_verified &&
    events.recovery_verified < start + durationMs && events.recovery_verified <= events.fault_cleared &&
    events.fault_cleared <= reset[1], 'Trial event markers are out of order or outside the driver window');
  // The driver can settle its last request before the nominal end of the window.
  requireEvidence(events.fault_cleared - start >= Math.floor(lastRequestMs),
    'Fault cleared before the last recorded request time');

  const controller = readFileSync(join(directory, 'controller.jsonl'), 'utf8').split(/\r?\n/)
    .filter(line => line.trim()).map(line => JSON.parse(line));
  const terminal = controller.at(-1);
  requireEvidence(controller.every(event => event?.deployment_id === trial.deployment_id) &&
    terminal?.status === 'ROLLED_BACK' && terminal.expected_version === '2.0.0' &&
    terminal.confirmation?.http_status === 500 && terminal.confirmation?.version === '2.0.0' &&
    terminal.recovery?.proxy_verified === true && terminal.recovery.verification?.passed === true &&
    terminal.recovery.verification.consecutive >= 3 &&
    terminal.recovery.last_proxy_observation?.http_status === 200 &&
    terminal.recovery.last_proxy_observation?.version === '1.0.0',
  'Controller log does not verify rollback to stable 1.0.0');
  for (const [event, iso] of [
    ['first_failure_probe', terminal.first_failure_probe_at],
    ['failure_confirmed', terminal.confirmed_at],
    ['rollback_started', terminal.recovery.started_at],
    ['recovery_verified', terminal.recovery.verified_at]
  ]) {
    requireEvidence(events[event] === Date.parse(iso), 'Controller log and events.csv disagree on ' + event);
  }
  let configuredDelay = null;
  let reconfirmationInterval = null;
  if (trial.arm === 'B') {
    const waiting = controller.filter(event => event.status === 'OPERATOR_DELAY_STARTED');
    configuredDelay = terminal.operator_delay_ms;
    reconfirmationInterval = events.rollback_reconfirmed - events.failure_confirmed;
    requireEvidence(waiting.length === 1 && Number.isSafeInteger(configuredDelay) && configuredDelay >= 0 &&
      waiting[0].operator_delay_ms === configuredDelay &&
      Date.parse(waiting[0].confirmed_at) === events.failure_confirmed &&
      Date.parse(terminal.reconfirmed_at) === events.rollback_reconfirmed &&
      reconfirmationInterval >= configuredDelay && events.rollback_reconfirmed <= events.rollback_started,
    'Arm B delay or reconfirmation evidence is inconsistent');
  } else {
    requireEvidence(!Object.hasOwn(events, 'rollback_reconfirmed') &&
      terminal.operator_delay_ms === undefined && !controller.some(event => event.status === 'OPERATOR_DELAY_STARTED'),
    'Arm A contains scripted delay evidence');
  }
  return {
    fault_activation_started_ms: events.fault_activation_started,
    fault_activated_ms: events.fault_activated,
    fault_activation_offset_ms: {
      started: events.fault_activation_started - start,
      completed: events.fault_activated - start
    },
    fault_activation_duration_ms: events.fault_activated - events.fault_activation_started,
    fault_ack_to_confirmation_ms: events.failure_confirmed - events.fault_activated,
    confirmation_to_rollback_ms: events.rollback_started - events.failure_confirmed,
    configured_operator_delay_ms: configuredDelay,
    confirmation_to_reconfirmation_ms: reconfirmationInterval,
    rollback_to_recovery_ms: events.recovery_verified - events.rollback_started,
    fault_ack_to_recovery_ms: events.recovery_verified - events.fault_activated,
    post_recovery_window_ms: start + durationMs - events.recovery_verified
  };
}

function analyzeTrial(directory, arm) {
  const readJson = file => JSON.parse(readFileSync(join(directory, file), 'utf8'));
  const trial = readJson('trial.json');
  const run = readJson('run.json');
  requireEvidence(trial.arm === arm && trial.status === 'TRIAL_PASSED' && trial.preflight_only === false &&
    typeof trial.trial_id === 'string' && trial.trial_id.length > 0 && trial.trial_id === run.run_id &&
    typeof trial.deployment_id === 'string' && trial.deployment_id.length > 0 &&
    trial.controller_status === 'ROLLED_BACK' && Array.isArray(trial.failures) && trial.failures.length === 0,
  'Trial summary is unsuccessful or does not match the requested arm and run ID');
  requireEvidence(run.status === 'complete' && run.review_required === false &&
    invariantNames.every(name => run.invariants?.[name] === true), 'Driver run is incomplete or needs review');

  const reset = trial.reset_checks;
  requireEvidence(reset?.routing_state?.deployment_id === null && reset.routing_state.pending_deployment_id === null &&
    reset.candidate_fault_flag === 'absent' && reset.proxy?.http_status === 200 && reset.proxy.version === '1.0.0',
  'Trial does not record a verified stable reset');
  requireEvidence(typeof run.git?.commit === 'string' && run.git.commit.length > 0 &&
    ['clean', 'dirty'].includes(run.git.working_tree), 'Missing Git provenance');

  const settings = settingsFrom(run);
  const { requests, lastRequestMs } = requestMeasurements(directory, run, settings);
  return {
    trial_id: trial.trial_id,
    deployment_id: trial.deployment_id,
    git: run.git,
    settings,
    requests,
    recovery: recoveryMeasurements(directory, trial, run, lastRequestMs)
  };
}

export function analyzePair(armADir, armBDir) {
  const arms = {};
  for (const [arm, directory] of [['A', armADir], ['B', armBDir]]) {
    try {
      arms[arm] = analyzeTrial(directory, arm);
    } catch (error) {
      throw new Error('Arm ' + arm + ' (' + directory + ') — ' + error.message, { cause: error });
    }
  }
  requireEvidence(arms.A.trial_id !== arms.B.trial_id && arms.A.deployment_id !== arms.B.deployment_id,
    'The pair must contain distinct trials and deployments');
  requireEvidence(Object.keys(arms.A.settings).every(name => arms.A.settings[name] === arms.B.settings[name]),
    'Workload settings differ between Arm A and Arm B');
  return {
    status: 'PAIR_VALID',
    window_ms: { start_inclusive: windowStartMs, end_exclusive: windowEndMs },
    rate_denominator: 'dispatched_requests',
    latency_percentile_method: 'nearest_rank',
    arms
  };
}
