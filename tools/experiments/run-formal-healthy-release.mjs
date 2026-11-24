import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { classifyWorkflowClient } from './workflow-client-classifier.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SECOND = 1_000_000_000n;
const WINDOW = 60n * SECOND;
const DURATION = 120n * SECOND;
const WARMUP = 5n * SECOND;
const SETTLEMENT = 30n * SECOND;
const STARTUP = 10n * SECOND;
const CONTROLLER_TIMEOUT_MS = 35_000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const message = error => error?.message ?? String(error);
const stable = sample => sample?.http_status === 200 && sample.version === '1.0.0';
const candidate = sample => sample?.http_status === 200 && sample.version === '2.0.0';
const time = event => BigInt(event.host_monotonic_ns);
const ns = value => typeof value === 'string' && /^\d+$/.test(value);
const safeName = value => typeof value === 'string' && /^[\w-][\w.-]*$/.test(value);
const clear = state => state?.deployment_id === null && state.pending_deployment_id === null;

async function waitUntil(deadline, signal) {
  for (let remaining = deadline - process.hrtime.bigint(); remaining > 0n;
    remaining = deadline - process.hrtime.bigint()) {
    await sleep(Math.ceil(Number(remaining) / 1e6), undefined, { signal });
  }
}

export function controllerResult(result, arm, cleanup = false) {
  try {
    const parsed = JSON.parse(result.stdout);
    const allowed = cleanup ? ['RESTORED', 'FAILED'] : arm === 'H'
      ? ['PROMOTED', 'PROMOTION_BLOCKED', 'PROMOTION_FAILED'] : ['SWITCHED', 'FAILED'];
    const expectedAction = cleanup ? 'restore' : 'switch';
    if (result.timedOut || !allowed.includes(parsed?.status) || result.signal || !Number.isInteger(result.exitCode) ||
        (arm === 'H' ? parsed.event !== 'candidate_promotion'
          : parsed.event !== 'conventional_release' || parsed.action !== expectedAction)) return null;
    const succeeded = ['PROMOTED', 'SWITCHED', 'RESTORED'].includes(parsed.status);
    if (succeeded !== (result.exitCode === 0) || (succeeded && !parsed.deployment_id)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseRequests(text) {
  const field = /("(?:[^"]|"")*"|[^,"\r\n]*)(,|\r\n|\n|\r|$)/y;
  const rows = [];
  let fields = [];
  let more = false;
  while (field.lastIndex < text.length || more) {
    const match = field.exec(text);
    if (!match) throw new SyntaxError('Invalid Driver CSV field');
    const [, value, delimiter] = match;
    fields.push(value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value);
    more = delimiter === ',';
    if (!more) {
      rows.push(fields);
      fields = [];
    }
  }
  const [header, ...records] = rows;
  const columns = 'run_id,seq,scheduled_ms,dispatched_ms,completed_ms,dispatch_delay_ms,latency_ms,outcome,http_status,error_code,miss_reason,version,warmup';
  if (header?.join(',') !== columns || records.some(row => row.length !== header.length)) {
    throw new SyntaxError('Unexpected Driver V1 CSV columns or row width');
  }
  return records.map(row => Object.fromEntries(header.map((column, index) => [column, row[index]])));
}

export function readWorkload(directory, runId) {
  const files = {};
  for (const [key, name, parse] of [
    ['run', 'run.json', JSON.parse], ['requests', 'requests.csv', parseRequests]
  ]) {
    const path = join(runId, name);
    let digest = null;
    try {
      const bytes = readFileSync(join(directory, path));
      digest = sha256(bytes);
      files[key] = { path, sha256: digest, value: parse(bytes.toString('utf8')) };
    } catch (error) {
      files[key] = { path, sha256: digest, error: message(error) };
    }
  }
  return files;
}

/**
 * Run one create-once S1 trial. A collection caller must honor nextArmAllowed.
 * frozen supplies { project, proxyUrl, stableConfigSha256, environmentFingerprint }.
 * The optional second argument supplies offline adapters for deterministic tests.
 */
export async function runFormalHealthyRelease({ arm, trialId, evidenceRoot, frozen }, adapters) {
  if (!['H', 'C'].includes(arm) || !safeName(trialId) || !evidenceRoot ||
      !safeName(frozen?.project) || typeof frozen.environmentFingerprint !== 'string' || !frozen.environmentFingerprint ||
      !/^[a-f0-9]{64}$/.test(frozen.stableConfigSha256 ?? '')) {
    throw new TypeError('Explicit S1 arm, trial ID, evidence root and frozen environment are required');
  }
  const url = URL.parse(frozen.proxyUrl);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/api/work' ||
      url.username || url.password || url.search || url.hash) throw new TypeError('Invalid frozen proxy URL');
  const environment = {
    project: frozen.project, proxyUrl: url.href, stableConfigSha256: frozen.stableConfigSha256,
    environmentFingerprint: frozen.environmentFingerprint
  };
  const ops = adapters ?? liveAdapters(environment);
  const directory = resolve(evidenceRoot, trialId);
  mkdirSync(resolve(evidenceRoot), { recursive: true });
  mkdirSync(directory);
  const runId = trialId + '-driver';
  const logPath = join(directory, 'events.jsonl');
  let eventNumber = 0;
  let origin = null;
  let cutoff = null;
  const record = (event, fields = {}, at = ops.now()) => {
    const entry = {
      id: trialId + ':' + ++eventNumber, event,
      host_monotonic_ns: at.toString(), ...fields
    };
    if (cutoff !== null) entry.after_primary_cutoff = at >= cutoff;
    appendFileSync(logPath, JSON.stringify(entry) + '\n');
    return entry;
  };
  const artifact = (name, value) => writeFileSync(join(directory, name), value, { flag: 'wx' });
  const capture = (name, result) => {
    artifact(name + '.stdout.log', result.stdout ?? '');
    artifact(name + '.stderr.log', result.stderr ?? '');
    return {
      exitCode: result.exitCode ?? null, signal: result.signal ?? null, error: result.error ?? null,
      ...(result.timedOut && { timed_out: true, timeout_ms: result.timeoutMs ?? CONTROLLER_TIMEOUT_MS })
    };
  };
  const start = record('trial_started', { scenario: 'S1', arm, trialId, runId, frozen: environment });
  let preflight = false;
  let driver;
  let driverExit = null;
  let bracket = null;
  let notificationCount = 0;
  let horizon = null;
  let deployment = null;
  let deploymentSettled = true;
  let monitorSettled = true;
  let monitor;
  let monitorStatus = null;
  let closedAdmission = false;
  let deployTask;
  let deployExit = null;
  let executionError = null;
  let externalVerification = null;
  let firstExternalCandidate = null;
  let observerError = null;
  let observerEnd = null;
  let observerTask;
  let completedPrimaryWait = false;
  const samples = [];
  const monitorReports = [];
  const routeEvidence = [];
  const observerStop = new AbortController();
  const recordTiming = marker => record('monitor_decision_timing', {
    marker, post_cutoff_action: ns(marker?.occurred_monotonic_ns) &&
      BigInt(marker.occurred_monotonic_ns) >= cutoff
  });

  async function observe() {
    let next = ops.now();
    let streak = [];
    try {
      while (!observerStop.signal.aborted) {
        await ops.waitUntil(next, observerStop.signal);
        if (observerStop.signal.aborted) break;
        const begun = ops.now();
        const result = await ops.observe();
        const seenAt = ops.now();
        const sample = record('external_probe', { role: 'external_verification',
          started_monotonic_ns: begun.toString(), observation: result }, seenAt);
        samples.push(sample);
        if (begun >= time(origin) && seenAt < cutoff) {
          if (candidate(result) && !firstExternalCandidate) firstExternalCandidate = sample;
          streak = candidate(result) ? [...streak.slice(-2), sample.id] : [];
          if (streak.length === 3 && !externalVerification) {
            externalVerification = record('candidate_externally_verified', { sample_ids: streak }, seenAt);
          }
        }
        next = begun + SECOND > seenAt ? begun + SECOND : seenAt;
      }
    } catch (error) {
      if (!observerStop.signal.aborted) observerError = record('observer_failed', { reason: message(error) });
    } finally {
      observerEnd = record('observer_finished', { sample_count: samples.length });
    }
  }

  try {
    record('preflight_passed', { evidence: await ops.preflight() });
    preflight = true;
    const spawned = ops.now();
    const notification = Promise.withResolvers();
    const driverArgs = ['tools/driver/driver.js', '--url', url.href, '--rate', '5',
      '--duration', '120', '--warmup', '5', '--timeout', '3000', '--max-concurrency', '50',
      '--max-lateness', '200', '--out', directory, '--run-id', runId, '--notify-start'];
    record('driver_spawned', { args: driverArgs }, spawned);
    driver = ops.startDriver(driverArgs, payload => {
      const arrival = record('driver_start_notification_received', { payload });
      if (++notificationCount === 1) notification.resolve({ payload, arrival });
    });
    const driverDone = driver.finished.then(result => {
      driverExit = record('driver_finished', capture('driver', result));
      return driverExit;
    });
    driver = { ...driver, finished: driverDone };
    const startupTimer = new AbortController();
    let received;
    try {
      received = await Promise.race([notification.promise, driverDone.then(() => null),
        ops.waitUntil(spawned + STARTUP, startupTimer.signal).then(() => null)]);
    } finally {
      startupTimer.abort();
    }
    const clock = received?.payload?.clock_alignment;
    if (!received || received.payload.event !== 'driver_start' || received.payload.run_id !== runId ||
        clock?.version !== 1 || clock.source !== 'process.hrtime.bigint' ||
        !ns(clock.start_before_ns) || !ns(clock.start_after_ns) ||
        BigInt(clock.start_before_ns) < spawned || BigInt(clock.start_after_ns) < BigInt(clock.start_before_ns) ||
        BigInt(clock.start_after_ns) > time(received.arrival) || time(received.arrival) >= spawned + STARTUP) {
      throw new Error('Missing, late, or invalid Driver V1 startup notification');
    }
    bracket = clock;
    horizon = BigInt(bracket.start_before_ns) + DURATION;
    const latestHorizon = BigInt(bracket.start_after_ns) + DURATION;
    const warm = BigInt(bracket.start_after_ns) + WARMUP;
    const warmupTimer = new AbortController();
    try {
      await Promise.race([ops.waitUntil(warm, warmupTimer.signal), driverDone]);
    } finally {
      warmupTimer.abort();
    }
    if (!clear(ops.routingState())) throw new Error('Routing ownership changed before deployment');
    const driverReady = !driverExit && ops.driverRunning(driver);
    const checkedAt = ops.now();
    const ready = driverReady && checkedAt >= warm && checkedAt + WINDOW <= horizon;
    record('prospective_coverage_check', {
      passed: ready, warmup_ends_ns: warm.toString(),
      schedule_end_bounds_ns: [horizon.toString(), latestHorizon.toString()],
      projected_cutoff_ns: (checkedAt + WINDOW).toString()
    }, checkedAt);
    if (!ready) throw new Error('Driver warm-up or remaining schedule horizon could not be established');

    if (!ops.driverRunning(driver)) throw new Error('Driver exited before deployment');
    const invokedAt = ops.now();
    if (invokedAt + WINDOW > horizon) throw new Error('Driver horizon elapsed before deployment invocation');
    cutoff = invokedAt + WINDOW;
    deploymentSettled = false;
    let invocation;
    try { invocation = ops.deploy(arm); }
    catch (error) { invocation = Promise.reject(error); }
    origin = record('deployment_invoked', { arm, cutoff_ns: cutoff.toString() }, invokedAt);
    deployTask = (async () => {
      try {
        const result = await invocation;
        deploymentSettled = true;
        deployment = controllerResult(result, arm);
        deployExit = record('deployment_returned', { ...capture('deployment', result), outcome: deployment });
        routeEvidence.push(record('routing_after_deployment', { state: ops.routingState() }));
        if (arm === 'H' && deployment?.status === 'PROMOTED' && ops.now() < horizon && !closedAdmission) {
          monitorSettled = false;
          record('monitor_invoked', { deployment_id: deployment.deployment_id, admission_end_ns: horizon.toString() });
          try {
            monitor = ops.startMonitor(deployment.deployment_id, horizon, report => {
              if (report.type === 'timing') recordTiming(report.value);
              else if (report.type === 'report') monitorReports.push(record('monitor_report', { outcome: report.value }));
              else if (report.type === 'status') record('monitor_worker_status', { outcome: report.value });
            });
            monitor.finished = monitor.finished.then(result => {
              monitorSettled = true;
              monitorStatus = record('monitor_finished', capture('monitor', result));
            }, error => {
              monitorSettled = true;
              monitorStatus = record('monitor_failed', { reason: message(error) });
            });
          } catch (error) {
            monitorSettled = true;
            monitorStatus = record('monitor_failed', { reason: message(error) });
          }
        }
      } catch (error) {
        deployExit = record('deployment_observation_failed', { reason: message(error) });
      }
    })();
    observerTask = observe();
    await ops.waitUntil(cutoff);
    completedPrimaryWait = true;
    record('primary_cutoff_observed', { cutoff_ns: cutoff.toString() });
    await driverDone;
  } catch (error) {
    executionError = record('runner_error', { reason: message(error) });
    if (!origin) driver?.stop();
  }

  if (driver && !driverExit) await driver.finished;
  observerStop.abort();
  await observerTask;

  // Closing admission leaves any recovery already admitted under the routing lock to settle.
  const settlementTimer = new AbortController();
  const settlementDeadline = (driverExit ? time(driverExit) : ops.now()) + SETTLEMENT;
  closedAdmission = true;
  monitor?.stop();
  const settled = (async () => {
    await deployTask;
    await monitor?.finished;
    return deploymentSettled && monitorSettled;
  })();
  let safeToInspect;
  try {
    safeToInspect = await Promise.race([settled,
      ops.waitUntil(settlementDeadline, settlementTimer.signal).then(() => false)]);
  } finally {
    settlementTimer.abort();
  }
  record('operations_settlement', { settled: safeToInspect, admission_closed: closedAdmission,
    deadline_ns: settlementDeadline.toString() });

  const workload = readWorkload(directory, runId);
  const run = workload.run.value;
  const endClock = run?.clock_alignment;
  const clockMatches = Boolean(notificationCount === 1 && bracket && run?.run_id === runId && driverExit &&
    ['source', 'version', 'start_before_ns', 'start_after_ns'].every(key => bracket[key] === endClock?.[key]) &&
    ns(endClock.end_before_ns) && ns(endClock.end_after_ns) &&
    BigInt(endClock.end_after_ns) <= time(driverExit));
  record('driver_clock_reconciliation', { passed: clockMatches });
  const classifierInputs = {
    scenario: 'S1', arm, origin, intervention: null, ...(externalVerification && { externalVerification }),
    expectedTargetUrl: url.href
  };
  const classification = classifyWorkflowClient({
    ...classifierInputs, run, requests: workload.requests.value
  });
  const inputReferences = Object.fromEntries(Object.entries(workload).map(([key, { value, ...ref }]) => [key, ref]));
  artifact('classifier.json', JSON.stringify({ inputs: classifierInputs, files: inputReferences, result: classification }, null, 2) + '\n');

  let cleanup = { status: 'blocked' };
  let reset = { status: 'unverified' };
  if (deployExit?.timed_out) {
    cleanup = { status: 'blocked', event: record('cleanup_blocked', {
      reason: 'Deployment timed out; routing changes require manual reconciliation',
      deployment_event_id: deployExit.id
    }) };
  } else if (preflight && safeToInspect && (!origin || (completedPrimaryWait && driverExit))) {
    try {
      const state = ops.routingState();
      routeEvidence.push(record('routing_before_cleanup', { state }));
      if (clear(state)) cleanup = { status: 'not_required' };
      else {
        const owner = state.deployment_id ?? state.pending_deployment_id;
        if (!owner || owner !== deployment?.deployment_id ||
            (state.deployment_id !== null && state.pending_deployment_id !== null)) {
          throw new Error('Routing owner cannot be safely attributed to this trial');
        }
        const begun = record('cleanup_restore_started', { deployment_id: owner, role: 'cleanup_restore' });
        let restoreExit;
        try {
          const result = await ops.restore(arm, owner, execution => {
            restoreExit = record('cleanup_controller_returned', {
              ...capture('cleanup-controller', execution), action_id: begun.id
            });
          });
          if (restoreExit?.timed_out) throw new Error('Restore timed out; routing changes require manual reconciliation');
          cleanup = { status: 'completed', event: record('cleanup_restore_returned', { result, action_id: begun.id }) };
        } catch (error) {
          cleanup = { status: restoreExit?.timed_out ? 'timed_out' : 'failed',
            event: record('cleanup_restore_failed', { reason: message(error), action_id: begun.id,
              controller_event_id: restoreExit?.id ?? null }) };
        }
      }
      if (['completed', 'not_required'].includes(cleanup.status)) reset = { status: 'verified', event: record('reset_verified', { evidence: await ops.reset() }) };
    } catch (error) {
      const failure = record('reset_blocked', { reason: message(error) });
      reset = { status: 'failed', event: failure };
    }
  }
  const primaryCovered = Boolean(clockMatches && cutoff !== null && classification.window?.observedThrough &&
    BigInt(classification.window.observedThrough[0]) >= cutoff);
  const externalCovered = Boolean(cutoff !== null && observerEnd && time(observerEnd) >= cutoff &&
    samples.some(sample => time(sample) < cutoff) &&
    samples.some(sample => {
      const began = BigInt(sample.started_monotonic_ns);
      return began < cutoff && (began + SECOND >= cutoff || time(sample) >= cutoff);
    }) && (!observerError || time(observerError) >= cutoff));
  const firstExternalNs = firstExternalCandidate && time(firstExternalCandidate);
  const firstClientNs = classification.candidate.firstSuccess?.completion?.[1];
  const regressions = firstExternalNs !== null ? samples.filter(sample =>
    BigInt(sample.started_monotonic_ns) >= firstExternalNs && !candidate(sample.observation)).map(sample => sample.id) : [];
  const clientRegressions = firstClientNs !== undefined ? (classification.trace.rows ?? []).filter(row =>
    row.dispatch_time && row.completion_time && BigInt(row.dispatch_time[0]) >= BigInt(firstClientNs) &&
    !(row.outcome === 'ok' && row.status === 200 && row.version === '2.0.0')).map(row => row.seq) : [];
  const workflow = {
    client_route_regression_request_ids: clientRegressions,
    deployment: deployment?.status ?? (origin ? 'UNKNOWN' : 'NOT_INVOKED'),
    route_regressions: regressions,
    monitor_outcomes: monitorReports.map(event => ({ id: event.id, status: event.outcome.status })),
    routing_events: routeEvidence.map(event => event.id)
  };
  const issues = [];
  if (!preflight || !clockMatches || classification.configuration.status !== 'compliant') issues.push('setup_or_clock_invalid');
  if (!primaryCovered || classification.accounting.completeness !== 'complete') issues.push('client_coverage_incomplete');
  if (!externalCovered) issues.push('external_coverage_incomplete');
  if (driverExit && (driverExit.exitCode !== 0 || classification.execution.status !== 'complete')) {
    issues.push('driver_execution_not_complete');
  }
  if (!deployment || !safeToInspect || (monitorStatus && monitorStatus.exitCode !== 0) ||
      (arm === 'H' && deployment?.status === 'PROMOTED' && !monitor)) issues.push('workflow_evidence_incomplete');
  const clientUsability = !clockMatches || classification.configuration.status !== 'compliant'
    ? 'unusable' : primaryCovered ? 'usable' : 'partial';
  const result = {
    scenario: 'S1', arm, trialId, runId, directory, start, origin, run_status: executionError ? 'incomplete' : 'completed',
    execution_error: executionError, controller: deployExit, driver: driverExit, monitor: monitorStatus,
    observer: { status: observerError ? 'failed' : observerEnd ? 'finished' : 'not_started', end: observerEnd,
      error: observerError, first_candidate: firstExternalCandidate, verification: externalVerification,
      primary_covered: externalCovered },
    workflow, validity: { status: issues.includes('setup_or_clock_invalid') ? 'invalid'
      : issues.length ? 'needs_review' : 'valid', issues },
    client_coverage: { primary_covered: primaryCovered, clock_matches: clockMatches, window: classification.window ?? null,
      followup: classification.followup ?? null, boundary_ambiguous_slots: classification.accounting.ambiguous ?? [] },
    client_metric_usability: clientUsability,
    metrics: { request_accounting: classification.accounting.completeness,
      deployment_overhead: classification.candidate.primary.completeness ?? 'insufficient',
      external_verification: externalVerification || externalCovered ? 'complete' : 'insufficient' },
    cleanup, reset, nextArmAllowed: reset.status === 'verified' && safeToInspect,
    classifier: 'classifier.json'
  };
  artifact('summary.json', JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function command(file, args, timeout) {
  return new Promise(resolve => {
    execFile(file, args, { cwd: root, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => resolve({
      stdout, stderr, exitCode: error ? typeof error.code === 'number' ? error.code : null : 0,
      signal: error?.signal ?? null, error: error && message(error)
    }));
  });
}

// Controllers can invoke synchronous subprocesses while holding the routing lock.
function controllerCommand(args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let error = null;
    let timedOut = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', cause => { error = message(cause); });
    const timer = setTimeout(() => {
      timedOut = true;
      error = 'Controller exceeded the ' + CONTROLLER_TIMEOUT_MS + ' ms command limit';
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (cause) {
        if (cause.code !== 'ESRCH') error += ': ' + message(cause);
      }
    }, CONTROLLER_TIMEOUT_MS);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal, error, timedOut, timeoutMs: CONTROLLER_TIMEOUT_MS });
    });
  });
}

function childProcess(args, onMessage) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '';
  let stderr = '';
  let error = null;
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('message', onMessage);
  child.on('error', cause => { error = message(cause); });
  const finished = new Promise(resolve => child.once('close', (exitCode, signal) =>
    resolve({ stdout, stderr, exitCode, signal, error })));
  return { child, finished };
}

export function liveAdapters(frozen) {
  const now = () => process.hrtime.bigint();
  const compose = ['compose', '--profile', 'routing'];
  const url = new URL(frozen.proxyUrl);
  let routing;
  let nginx;
  let observeProxy;
  const probeSource = `
    const checks = [];
    for (const endpoint of ['/health', '/ready', '/api/work']) {
      const response = await fetch('http://127.0.0.1:3000' + endpoint,
        { signal: AbortSignal.timeout(1500), redirect: 'manual' });
      const body = await response.json();
      checks.push({ endpoint, status: response.status, version: body.version ?? null });
    }
    console.log(JSON.stringify(checks));
  `;
  async function reset() {
    const binding = await command('docker', [...compose, 'port', 'nginx', '80'], 10_000);
    if (binding.exitCode !== 0 || binding.stdout.trim() !== url.host) throw new Error('Frozen proxy binding check failed');
    const state = routing.readRoutingState();
    const stableConfig = sha256(nginx.readRuntimeConfig());
    if (!clear(state) || stableConfig !== frozen.stableConfigSha256) throw new Error('Stable routing state or config check failed');
    const publicRoute = await observeProxy(1000, { url: url.href });
    if (!stable(publicRoute)) throw new Error('Stable public workload did not return HTTP 200 / 1.0.0');
    const fault = await command('docker', [...compose, 'exec', '-T', 'candidate', 'sh', '-eu', '-c',
      'test -n "$WORKLOAD_FAULT_FILE"; test ! -e "$WORKLOAD_FAULT_FILE"'], 10_000);
    if (fault.exitCode !== 0) throw new Error('Candidate workload fault state could not be verified clear');
    const probes = await command('docker', [...compose, 'exec', '-T', 'candidate',
      'node', '--input-type=module', '-e', probeSource], 10_000);
    if (probes.exitCode !== 0) throw new Error('Candidate health, dependency or workload check failed');
    const checks = JSON.parse(probes.stdout);
    if (checks.length !== 3 || checks.some(check => check.status !== 200) ||
        checks[2].endpoint !== '/api/work' || checks[2].version !== '2.0.0') {
      throw new Error('Candidate preflight did not verify healthy version 2.0.0');
    }
    return { state, stable_config_sha256: stableConfig, public_route: publicRoute, candidate_checks: checks, proxy_binding: url.host };
  }
  return {
    now, waitUntil,
    async preflight() {
      if (process.env.COMPOSE_PROJECT_NAME !== frozen.project ||
          process.env.DEPLOYMENT_PROXY_URL !== url.href ||
          url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
        throw new Error('Explicit frozen Compose project and loopback proxy environment required');
      }
      routing = await import('../controller/deployment-state.mjs');
      nginx = await import('../controller/nginx-routing.mjs');
      ({ observeProxy } = await import('../controller/observe-proxy.mjs'));
      return reset();
    },
    reset,
    routingState: () => routing.readRoutingState(),
    observe: () => observeProxy(1000, { url: url.href, versionStatuses: [200, 500] }),
    startDriver(args, onMessage) {
      const task = childProcess(args, onMessage);
      const timeout = setTimeout(() => task.child.kill('SIGTERM'), 150_000);
      const hardTimeout = setTimeout(() => task.child.kill('SIGKILL'), 160_000);
      timeout.unref();
      hardTimeout.unref();
      task.finished.then(() => {
        clearTimeout(timeout);
        clearTimeout(hardTimeout);
      });
      return { ...task, stop: () => task.child.kill('SIGTERM') };
    },
    driverRunning: ({ child }) => child.exitCode === null && child.signalCode === null,
    deploy: arm => controllerCommand(arm === 'H' ? ['tools/controller/promote.mjs']
      : ['tools/controller/conventional-release.mjs', 'switch']),
    startMonitor(id, horizon, onMessage) {
      const task = childProcess([fileURLToPath(import.meta.url), '--monitor-worker', id, String(horizon)], onMessage);
      return {
        finished: task.finished,
        stop: () => {
          if (task.child.connected) task.child.send({ stop: true }, () => {});
        }
      };
    },
    async restore(arm, owner, onControllerResult, onInvoke) {
      if (arm === 'C') {
        const deployment = routing.readDeployment(owner);
        if (deployment.manifest.workflow !== 'conventional' ||
            sha256(deployment.previous) !== frozen.stableConfigSha256) {
          throw new Error('Conventional cleanup requires its frozen stable snapshot');
        }
        onInvoke?.();
        const result = await controllerCommand(['tools/controller/conventional-release.mjs', 'restore', owner]);
        onControllerResult(result);
        const parsed = controllerResult(result, arm, true);
        if (parsed?.status !== 'RESTORED') throw new Error(result.error ?? parsed?.reason ?? 'Unverified conventional cleanup result');
        return parsed;
      }
      const { rollbackDeployment } = await import('../controller/rollback.mjs');
      return routing.withRoutingLock(async () => {
        const state = routing.readRoutingState();
        const deployment = routing.readDeployment(owner);
        if (state.deployment_id !== owner || state.pending_deployment_id !== null ||
            deployment.manifest.workflow === 'conventional' || deployment.manifest.status !== 'PROMOTED' ||
            sha256(deployment.previous) !== frozen.stableConfigSha256) {
          throw new Error('Health-aware cleanup requires the owned promoted route and frozen stable snapshot');
        }
        const result = await rollbackDeployment(deployment, null);
        if (result.status !== 'ROLLED_BACK') throw new Error('Health-aware cleanup did not complete: ' + JSON.stringify(result));
        return result;
      });
    }
  };
}

// Separate process keeps rollback's synchronous Nginx calls off the observer and runner clocks.
async function monitorWorker(id, horizon) {
  if (!process.connected || !ns(horizon)) throw new Error('Monitor worker requires IPC and an admission horizon');
  const { monitorDeployment } = await import('../controller/monitor.mjs');
  const { withRoutingLock } = await import('../controller/deployment-state.mjs');
  const { observeProxy } = await import('../controller/observe-proxy.mjs');
  let stop = false;
  let locked = false;
  process.on('message', request => { if (request?.stop === true) stop = true; });
  process.on('disconnect', () => { stop = true; });
  const closed = new Error('Monitor admission closed');
  const checkAdmission = () => { if (stop || process.hrtime.bigint() >= BigInt(horizon)) throw closed; };
  const send = (type, value) => {
    if (process.connected) process.send({ type, value }, error => {
      if (error) console.error('Monitor evidence IPC failed: ' + message(error));
    });
  };
  try {
    const status = await monitorDeployment(id, {
      observe() {
        if (!locked) checkAdmission();
        return observeProxy(1000, { versionStatuses: [200, 500] });
      },
      lockRouting: action => withRoutingLock(async () => {
        checkAdmission();
        locked = true;
        try { return await action(); } finally { locked = false; }
      }),
      report: value => send('report', value),
      onDecisionTiming: value => send('timing', value)
    });
    send('status', { status });
  } catch (error) {
    if (error !== closed) throw error;
    send('status', { status: 'ADMISSION_CLOSED' });
  } finally {
    // The approved monitor queues its timing hook on setImmediate.
    await new Promise(resolve => setImmediate(resolve));
    if (process.connected) process.disconnect();
  }
}

if (import.meta.main) {
  const [mode, id, horizon] = process.argv.slice(2);
  if (mode === '--monitor-worker') await monitorWorker(id, horizon);
  else throw new Error('Import runFormalHealthyRelease and supply explicit trial and frozen environment inputs');
}
