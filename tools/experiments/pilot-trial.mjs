import { spawnSync } from 'node:child_process';
import {
  appendFileSync, closeSync, constants, copyFileSync, existsSync, mkdirSync,
  openSync, readFileSync, readdirSync, rmSync
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { deploymentsPath, readDeploymentManifest, writeAtomic } from '../controller/deployment-state.mjs';
import { startPilotProcess } from './pilot-process.mjs';

const workloadUrl = 'http://127.0.0.1:8080/api/work';
const durationMs = 60_000;
const faultDelayMs = 15_000;
const operatorDelayMs = 10_000;

function lockTrial(resultsDir) {
  // The runner lock is separate from the controller's routing lock.
  const fd = openSync(join(resultsDir, '.pilot.lock'), 'a', 0o600);
  try {
    const result = spawnSync('flock', ['-n', '-E', '75', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', timeout: 5000
    });
    if (result.error) throw result.error;
    if (result.status === 75) throw new Error('Another pilot trial is running');
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not acquire the pilot lock');
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function saveJson(directory, name, data) {
  writeAtomic(join(directory, name), JSON.stringify(data, null, 2) + '\n');
}

function readJson(directory, name) {
  return JSON.parse(readFileSync(join(directory, name), 'utf8'));
}

function succeeded(result) {
  return result.exit_code === 0 && !result.signal && !result.error && !result.stop_reason;
}

function collectDriver(report, record) {
  const driver = readJson(report.run_dir, 'run.json');
  report.driver_status = driver.status;
  report.driver_review_required = driver.review_required;
  if (Number.isFinite(driver.wall_start_ms)) record('driver_started', driver.wall_start_ms, 'driver');
  if (driver.run_id !== report.trial_id || driver.status !== 'complete' ||
      driver.summary?.offered !== 300 || driver.review_required ||
      !Object.values(driver.invariants ?? {}).length ||
      Object.values(driver.invariants).some(value => value !== true) ||
      !existsSync(join(report.run_dir, 'requests.csv'))) {
    throw new Error('Driver results are incomplete or need review');
  }
}

function collectController(report, record) {
  const lines = readFileSync(join(report.staging_dir, 'controller.jsonl'), 'utf8').trim().split(/\r?\n/);
  let terminal;
  let lastTimedEvent;
  let malformed = false;
  for (const line of lines.filter(Boolean)) {
    try {
      terminal = JSON.parse(line);
    } catch {
      malformed = true;
      continue;
    }
    if (terminal?.deployment_id !== report.deployment_id) {
      malformed = true;
      continue;
    }
    if (terminal.first_failure_probe_at || terminal.confirmed_at) lastTimedEvent = terminal;
  }
  for (const [event, timestamp] of [
    ['first_failure_probe', lastTimedEvent?.first_failure_probe_at],
    ['failure_confirmed', lastTimedEvent?.confirmed_at],
    ['rollback_reconfirmed', lastTimedEvent?.reconfirmed_at],
    ['rollback_started', lastTimedEvent?.recovery?.started_at],
    ['recovery_verified', lastTimedEvent?.recovery?.verified_at]
  ]) {
    const time = Date.parse(timestamp);
    if (Number.isFinite(time)) record(event, time, 'controller');
  }
  report.controller_status = terminal?.status ?? null;
  if (malformed || terminal?.deployment_id !== report.deployment_id ||
      terminal.status !== 'ROLLED_BACK' || terminal.recovery?.proxy_verified !== true ||
      terminal.recovery?.verification?.consecutive !== 3 ||
      terminal.recovery?.last_proxy_observation?.version !== '1.0.0' ||
      terminal.recovery?.last_proxy_observation?.http_status !== 200) {
    throw new Error('Controller evidence does not verify rollback to stable 1.0.0');
  }
}

function checkTimeline(report, events) {
  const time = name => events.find(event => event.event === name)?.wall_ms;
  const start = time('driver_started');
  const faultStart = time('fault_activation_started');
  const faultEnd = time('fault_activated');
  if ([start, faultStart, faultEnd].every(Number.isFinite)) {
    report.fault_offset_ms = { started: faultStart - start, completed: faultEnd - start };
  }
  const confirmed = time('failure_confirmed');
  const rollback = time('rollback_started');
  const recovered = time('recovery_verified');
  const required = [start, faultStart, faultEnd, time('first_failure_probe'), confirmed, rollback, recovered];
  if (!required.every(Number.isFinite) || start > faultStart || faultStart > faultEnd ||
      time('first_failure_probe') < faultStart || time('first_failure_probe') > confirmed ||
      faultEnd > recovered || confirmed > rollback || rollback > recovered || recovered >= start + durationMs) {
    throw new Error('Required timing evidence is missing, out of order, or outside the driver window');
  }
  if (report.arm === 'B') {
    const reconfirmed = time('rollback_reconfirmed');
    if (!Number.isFinite(reconfirmed) || reconfirmed < confirmed + operatorDelayMs || reconfirmed > rollback) {
      throw new Error('Arm B timing does not show the configured delay and reconfirmation');
    }
  }
  report.timing_ms = {
    confirmation_to_rollback: rollback - confirmed,
    rollback_to_verified_recovery: recovered - rollback,
    post_recovery_in_driver_window: start + durationMs - recovered
  };
}

function archiveState(report) {
  const active = join(deploymentsPath, 'active-deployment.json');
  if (existsSync(active)) copyFileSync(active, join(report.staging_dir, 'active-deployment.json'));
  if (!report.deployment_id) return;
  const directory = join(deploymentsPath, report.deployment_id);
  for (const name of ['deployment.json', 'previous-nginx.conf', 'candidate-nginx.conf']) {
    const source = join(directory, name);
    if (existsSync(source)) copyFileSync(source, join(report.staging_dir, name));
  }
}

function publishEvidence(report, driverStarted) {
  if (driverStarted && existsSync(report.run_dir)) {
    const driverError = readFileSync(join(report.staging_dir, 'driver.stderr.log'), 'utf8');
    if (/run directory already exists|Output failure \(create_run_directory\): EEXIST/.test(driverError)) {
      throw new Error('The result directory was claimed by a different process');
    }
  } else {
    mkdirSync(report.run_dir, { mode: 0o700 });
  }
  for (const name of readdirSync(report.staging_dir)) {
    copyFileSync(join(report.staging_dir, name), join(report.run_dir, name), constants.COPYFILE_EXCL);
  }
  rmSync(report.staging_dir, { recursive: true });
}

export async function runPilot(report, { repoRoot, resultsDir, faultFlag, compose, checkPreflight }) {
  const stage = report.staging_dir;
  const events = [];
  report.failures = [];
  const failure = (step, error) => report.failures.push({ step, reason: error.message });
  function record(event, wall_ms = Date.now(), source = 'runner', repeat = false) {
    if (!repeat && events.some(entry => entry.event === event)) return;
    const entry = { trial_id: report.trial_id, arm: report.arm, event, wall_ms, source };
    events.push(entry);
    appendFileSync(join(stage, 'runner-events.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error('Trial interrupted'));
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const start = (args, stdout, stderr, timeout = 75_000) =>
    startPilotProcess({ cwd: repoRoot, stagingDir: stage, args, stdout, stderr, timeout, signal: stop.signal });

  let lockFd;
  let step = 'trial_lock';
  let promotion;
  let driver;
  let monitor;
  let faultAttempted = false;
  let faultSucceeded = false;
  try {
    try {
      record('trial_start', Date.parse(report.started_at));
      lockFd = lockTrial(resultsDir);
      step = 'preflight';
      try {
        await checkPreflight(report.checks);
        record('reset_verified');
      } finally {
        saveJson(stage, 'preflight.json', report.checks);
      }

      step = 'promotion';
      promotion = start(['tools/controller/promote.mjs'], 'promotion.json', 'promotion.stderr.log', 90_000);
      report.promotion_process = await promotion.finished;
      const promotionOutput = readFileSync(join(stage, 'promotion.json'), 'utf8').trim();
      if (!promotionOutput) {
        throw new Error(report.promotion_process.error ?? report.promotion_process.stop_reason ??
          'Promotion exited without a JSON report');
      }
      const promoted = JSON.parse(promotionOutput);
      if (typeof promoted.deployment_id === 'string' &&
          /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(promoted.deployment_id)) {
        report.deployment_id = promoted.deployment_id;
      }
      if (!succeeded(report.promotion_process) || promoted.status !== 'PROMOTED' || !report.deployment_id) {
        throw new Error(promoted.reason || 'Promotion did not return PROMOTED');
      }
      const manifest = readDeploymentManifest(report.deployment_id);
      const promotedAt = Date.parse(manifest.verified_at);
      if (manifest.status !== 'PROMOTED' || !Number.isFinite(promotedAt)) {
        throw new Error('Promotion manifest has no verified promotion');
      }
      record('promotion_verified', promotedAt, 'controller');

      step = 'start_children';
      if (existsSync(report.run_dir)) throw new Error('Result directory already exists for this trial ID');
      const monitorArgs = ['tools/controller/monitor.mjs'];
      if (report.arm === 'B') monitorArgs.push('--operator-delay-ms', String(operatorDelayMs));
      monitor = start([...monitorArgs, report.deployment_id], 'controller.jsonl', 'controller.stderr.log');
      driver = start([
        'tools/driver/driver.js', '--url', workloadUrl, '--rate', '5', '--duration', '60',
        '--warmup', '5', '--timeout', '3000', '--out', resultsDir, '--run-id', report.trial_id
      ], 'driver.stdout.log', 'driver.stderr.log');
      record('driver_spawned');

      step = 'wait_to_inject';
      const beforeFault = new AbortController();
      const abortFaultTimer = () => beforeFault.abort();
      stop.signal.addEventListener('abort', abortFaultTimer, { once: true });
      try {
        stop.signal.throwIfAborted();
        const first = await Promise.race([
          sleep(faultDelayMs, 'fault_due', { signal: beforeFault.signal }),
          driver.finished.then(() => 'driver exited'),
          monitor.finished.then(() => 'monitor exited')
        ]);
        if (first !== 'fault_due' || driver.exited || monitor.exited) {
          throw new Error('Driver or monitor exited before fault activation');
        }
      } finally {
        beforeFault.abort();
        stop.signal.removeEventListener('abort', abortFaultTimer);
      }

      step = 'fault_activation';
      stop.signal.throwIfAborted();
      record('fault_activation_started');
      faultAttempted = true;
      await compose('exec', '-T', 'candidate', 'touch', faultFlag);
      faultSucceeded = true;
      record('fault_activated');
    } catch (error) {
      failure(step, error);
    } finally {
      try {
        if (monitor && !faultSucceeded) monitor.stop('Trial stopped before confirming fault activation');
        const [driverResult, monitorResult] = await Promise.all([driver?.finished, monitor?.finished]);
        if (driverResult) {
          report.driver_process = driverResult;
          if (!succeeded(driverResult)) {
            failure('driver_process', new Error(driverResult.error ?? driverResult.stop_reason ?? 'Driver exited unsuccessfully'));
          }
          try { collectDriver(report, record); } catch (error) { failure('driver_evidence', error); }
        }
        if (monitorResult) {
          report.monitor_process = monitorResult;
          if (!succeeded(monitorResult)) {
            failure('monitor_process', new Error(monitorResult.error ?? monitorResult.stop_reason ?? 'Monitor exited unsuccessfully'));
          }
          try { collectController(report, record); } catch (error) { failure('controller_evidence', error); }
        }
      } finally {
        if (faultAttempted) {
          try {
            await compose('exec', '-T', 'candidate', 'rm', '-f', faultFlag);
            record('fault_cleared');
          } catch (error) {
            failure('fault_cleanup', error);
          }
        }
        if (promotion) {
          report.reset_checks = {};
          try {
            await checkPreflight(report.reset_checks);
            record('reset_verified', Date.now(), 'runner', true);
          } catch (error) {
            failure('reset', error);
          }
        }
      }
    }

    if (stop.signal.aborted) failure('interrupted', stop.signal.reason);
    if (driver) {
      try { checkTimeline(report, events); } catch (error) { failure('timeline', error); }
    }
    if (lockFd !== undefined) {
      try { archiveState(report); } catch (error) { failure('archive', error); }
    }
    const csv = ['trial_id,arm,event,wall_ms,source'];
    for (const event of events.sort((a, b) => a.wall_ms - b.wall_ms)) {
      csv.push([event.trial_id, event.arm, event.event, event.wall_ms, event.source].join(','));
    }
    writeAtomic(join(stage, 'events.csv'), csv.join('\n') + '\n');
    report.completed_at = new Date().toISOString();
    report.status = report.failures.length ? 'TRIAL_FAILED' : 'TRIAL_PASSED';
    saveJson(stage, 'trial.json', report);
    try {
      publishEvidence(report, !!driver);
    } catch (error) {
      failure('publish_evidence', error);
      report.status = 'TRIAL_FAILED';
      saveJson(stage, 'trial.json', report);
    }
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
