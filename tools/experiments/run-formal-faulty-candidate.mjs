import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { classifyWorkflowClient } from './workflow-client-classifier.mjs';
import { command, controllerResult, liveAdapters, readWorkload } from './run-formal-healthy-release.mjs';

const SECOND = 1_000_000_000n;
const PRIMARY = 60n * SECOND;
const DURATION = 120n * SECOND;
const WARMUP = 5n * SECOND;
const STARTUP = 10n * SECOND;
const OPERATOR_DELAY = 10n * SECOND;
const SETTLEMENT = 30n * SECOND;
const PREPARATION_TOLERANCE = 5n * SECOND;
const decimal = value => typeof value === 'string' && /^\d+$/.test(value);
const identifier = value => typeof value === 'string' && /^[\w-][\w.-]*$/.test(value);
const stamp = event => BigInt(event.host_monotonic_ns);
const stable = observation => observation?.http_status === 200 && observation.version === '1.0.0';
const faulty = observation => observation?.http_status === 500 && observation.version === '2.0.0';
const unowned = state => state?.deployment_id === null && state.pending_deployment_id === null;
const owns = (state, id) => id && state?.deployment_id === id && state.pending_deployment_id === null;
const message = error => error?.message ?? String(error);
const uncertainExecution = execution => execution.timed_out || execution.signal !== null || execution.exit_code === null;
const elapsed = (start, end) => start && end ? {
  start_event_id: start.id, end_event_id: end.id, elapsed_ns: String(stamp(end) - stamp(start))
} : null;

async function untilOr(ops, deadline, other) {
  const timer = new AbortController();
  try {
    return await Promise.race([other, ops.waitUntil(deadline, timer.signal).then(() => null)]);
  } finally {
    timer.abort();
  }
}

function startClock(received, spawned, runId) {
  const { payload, arrival } = received ?? {};
  const clock = payload?.clock_alignment;
  if (payload?.event !== 'driver_start' || payload.run_id !== runId ||
      clock?.version !== 1 || clock.source !== 'process.hrtime.bigint' ||
      !decimal(clock.start_before_ns) || !decimal(clock.start_after_ns) ||
      BigInt(clock.start_before_ns) < spawned || BigInt(clock.start_after_ns) < BigInt(clock.start_before_ns) ||
      BigInt(clock.start_after_ns) > stamp(arrival) || stamp(arrival) >= spawned + STARTUP) return null;
  return clock;
}

/**
 * Run one formal S2 arm. Frozen settings use the S1 environment interface.
 * The caller must honor nextArmAllowed. Optional adapters support offline fixtures.
 */
export function runFormalFaultyCandidate(input, adapters) {
  return runFormalFaultScenario(input, adapters);
}

export async function runFormalFaultScenario({ arm, trialId, evidenceRoot, frozen }, adapters, postRollout) {
  const scenario = postRollout ? 'S3' : 'S2';
  const url = typeof frozen?.proxyUrl === 'string' ? URL.parse(frozen.proxyUrl) : null;
  if (!['H', 'C'].includes(arm) || !identifier(trialId) || !evidenceRoot ||
      !identifier(frozen?.project) || !/^[a-f0-9]{64}$/.test(frozen.stableConfigSha256 ?? '') ||
      typeof frozen.environmentFingerprint !== 'string' || !frozen.environmentFingerprint ||
      !url || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/api/work' ||
      url.username || url.password || url.search || url.hash) {
    throw new TypeError('Explicit ' + scenario + ' arm, trial ID, evidence root and frozen environment are required');
  }
  const environment = { project: frozen.project, proxyUrl: url.href,
    stableConfigSha256: frozen.stableConfigSha256, environmentFingerprint: frozen.environmentFingerprint };
  const ops = adapters ?? faultyCandidateAdapters(environment, postRollout?.faultBudget);
  const directory = resolve(evidenceRoot, trialId);
  mkdirSync(resolve(evidenceRoot), { recursive: true });
  mkdirSync(directory);
  const runId = trialId + '-driver';
  const evidence = name => join(directory, name);
  let seq = 0;
  let cutoff;
  const record = (event, fields = {}, at = ops.now()) => {
    const entry = { id: trialId + ':' + ++seq, event, host_monotonic_ns: String(at), ...fields,
      ...(cutoff !== undefined && { after_primary_cutoff: at >= cutoff }) };
    appendFileSync(evidence('events.jsonl'), JSON.stringify(entry) + '\n');
    return entry;
  };
  const save = (name, value) => writeFileSync(evidence(name), value, { flag: 'wx' });
  function capture(name, result) {
    save(name + '.stdout.log', result.stdout ?? '');
    save(name + '.stderr.log', result.stderr ?? '');
    return { exit_code: result.exitCode ?? null, signal: result.signal ?? null, error: result.error ?? null,
      timed_out: result.timedOut === true };
  }

  record('trial_started', { scenario, arm, trialId, runId, frozen: environment });
  let stage = 'PREFLIGHT';
  let preflight = false;
  let driver;
  let driverExit;
  let driverDone;
  let bracket;
  let horizon;
  let notifications = 0;
  let faultAttempt;
  let faultInvoked;
  let faultWrite;
  let faultAck;
  let confirmed;
  let stableBeforeDeploy;
  let origin;
  let deploymentInvoked;
  let faultStarted;
  let faultStateAfterWrite;
  let stageReason;
  let candidateVerified;
  const candidateStreak = [];
  const verification = Promise.withResolvers();
  const observerFinished = Promise.withResolvers();
  let deployment;
  let deployReturned;
  let deployedOwnership;
  let deployTask;
  let monitor;
  let monitorStatus;
  let monitorFinished;
  let monitorStopped = false;
  let restore;
  let restoreReturned;
  let restoreTask;
  let alert;
  let operatorDue;
  let ownershipUncertain = false;
  let executionError;
  let observerError;
  let observerEnd;
  let observerTask;
  let admissionClosed = false;
  let settlementDeadline;
  let operationsExpired = false;
  let primaryWaitComplete = false;
  const monitorReports = [];
  const monitorTimings = [];
  const samples = [];
  const alertStreak = [];
  const driverLive = () => !driverExit && ops.driverRunning(driver);
  const stopObserver = new AbortController();

  function stopMonitor() {
    if (monitor && !monitorStopped) {
      monitorStopped = true;
      monitor.stop();
    }
  }

  async function performRestore() {
    const owner = deployment.deployment_id;
    await ops.waitUntil(operatorDue);
    try {
      if (operationsExpired || (settlementDeadline !== undefined && ops.now() >= settlementDeadline)) {
        restoreReturned = record('operator_restore_not_invoked', { reason: 'Settlement deadline elapsed',
          alert_id: alert.id, deployment_id: owner });
        return;
      }
      if (!owns(ops.routingState(), owner)) {
        restoreReturned = record('operator_restore_not_invoked', { reason: 'Deployment no longer solely owns the active route',
          alert_id: alert.id, deployment_id: owner });
        return;
      }
      const result = await ops.restore('C', owner, raw => {
        // This callback can precede an adapter rejection for a parseable refusal.
        restoreReturned = { raw };
      }, () => {
        const at = ops.now();
        if (operationsExpired || (settlementDeadline !== undefined && at >= settlementDeadline)) {
          throw new Error('Settlement deadline elapsed before restore invocation');
        }
        restore = record('operator_restore_invoked', { role: 'normal_workflow_restore',
          deployment_id: owner, alert_id: alert.id, due_monotonic_ns: String(operatorDue),
          post_cutoff_action: at >= cutoff }, at);
      });
      finishRestore(result);
    } catch (error) {
      finishRestore(null, error);
    }
  }

  function finishRestore(result, error) {
    const raw = restoreReturned?.raw;
    const execution = raw ? capture('operator-restore', raw) : null;
    const outcome = raw ? controllerResult(raw, 'C', true) : result;
    if (!outcome || (execution && uncertainExecution(execution))) ownershipUncertain = true;
    restoreReturned = record('operator_restore_returned', { action_id: restore?.id ?? null,
      execution, outcome, reason: error ? message(error) : null });
  }

  let alertCursor = 0;
  function evaluateAlertSamples() {
    if (arm !== 'C' || deployment?.status !== 'SWITCHED' || alert || admissionClosed ||
        (postRollout && !faultAck)) return;
    while (alertCursor < samples.length) {
      const sample = samples[alertCursor++];
      if (stamp(sample) >= horizon) return;
      if (postRollout && BigInt(sample.started_monotonic_ns) < stamp(faultStarted)) continue;
      if (!faulty(sample.observation)) alertStreak.length = 0;
      else alertStreak.push(sample.id);
      if (alertStreak.length === 3) {
        const completed = stamp(sample);
        alert = record('external_alert', { role: 'decision_alert', source_sample_ids: [...alertStreak],
          source_sample_id: sample.id, recorded_monotonic_ns: String(ops.now()), post_cutoff_action: completed >= cutoff }, completed);
        operatorDue = completed + OPERATOR_DELAY;
        record('operator_delay_scheduled', { alert_id: alert.id, due_monotonic_ns: String(operatorDue), delay_ms: 10_000 });
        restoreTask = performRestore();
        return;
      }
    }
  }

  async function observe() {
    let next = ops.now();
    try {
      while (!stopObserver.signal.aborted) {
        await ops.waitUntil(next, stopObserver.signal);
        if (stopObserver.signal.aborted) break;
        const started = ops.now();
        const observation = await ops.observe();
        const completed = ops.now();
        const sample = record('external_probe', { role: 'external_observer',
          started_monotonic_ns: String(started), observation }, completed);
        samples.push(sample);
        if (postRollout && !candidateVerified) {
          if (observation?.http_status === 200 && observation.version === '2.0.0') candidateStreak.push(sample.id);
          else candidateStreak.length = 0;
          if (candidateStreak.length === 3) {
            candidateVerified = record('candidate_externally_verified', { role: 'pre_fault_verification',
              source_sample_ids: [...candidateStreak] }, completed);
            verification.resolve(candidateVerified);
          }
        }
        evaluateAlertSamples();
        next = started + SECOND > completed ? started + SECOND : completed;
      }
    } catch (error) {
      if (!stopObserver.signal.aborted) observerError = record('observer_failed', { reason: message(error) });
    } finally {
      observerEnd = record('observer_finished', { sample_count: samples.length });
      observerFinished.resolve(observerEnd);
    }
  }

  function monitorMessage(report) {
    if (report.type === 'timing') {
      const marker = report.value;
      const source = decimal(marker?.occurred_monotonic_ns) ? BigInt(marker.occurred_monotonic_ns) : null;
      const receipt = record('monitor_timing_received', { marker,
        post_cutoff_action: source !== null && cutoff !== undefined && source >= cutoff });
      monitorTimings.push(receipt);
      if (!postRollout && marker?.event === 'locked_degradation_confirmed' && source !== null &&
          source >= stamp(origin) && source <= stamp(receipt) && marker.deployment_id === deployment?.deployment_id && !restore) {
        restore = record('automatic_restore_started', { role: 'normal_workflow_restore',
          deployment_id: marker.deployment_id, source_event_id: receipt.id,
          post_cutoff_action: source >= cutoff }, source);
      }
    } else if (report.type === 'report') {
      monitorReports.push(record('monitor_report', { outcome: report.value }));
    } else if (report.type === 'status') {
      monitorStatus = record('monitor_worker_status', { outcome: report.value });
    }
  }

  async function deploymentResult(invocation) {
    try {
      const raw = await invocation;
      deployment = controllerResult(raw, arm);
      const execution = capture('deployment', raw);
      if (!deployment || uncertainExecution(execution)) ownershipUncertain = true;
      deployReturned = record('deployment_returned', { execution, outcome: deployment });
      const state = ops.routingState();
      deployedOwnership = record('routing_after_deployment', { state, deployment_event_id: deployReturned.id });
      if (arm === 'H' && deployment?.status === 'PROMOTED' && owns(state, deployment.deployment_id) &&
          !admissionClosed && ops.now() < horizon) {
        record('monitor_invoked', { deployment_id: deployment.deployment_id, admission_end_ns: String(horizon) });
        monitor = ops.startMonitor(deployment.deployment_id, horizon, monitorMessage);
        monitor.finished = monitor.finished.then(result =>
          monitorFinished = record('monitor_finished', { execution: capture('monitor', result) }), error =>
          monitorFinished = record('monitor_failed', { reason: message(error) }));
      }
      evaluateAlertSamples();
    } catch (error) {
      ownershipUncertain = true;
      record('deployment_or_monitor_observation_failed', { reason: message(error) });
    }
  }

  function readiness(label, warm) {
    const state = ops.routingState();
    const running = !driverExit && ops.driverRunning(driver);
    const at = ops.now();
    const passed = unowned(state) && running && at >= warm && at + PRIMARY <= horizon;
    record('prospective_coverage_check', { phase: label, passed, state, warmup_end_ns: String(warm),
      schedule_end_bounds_ns: [String(horizon), String(BigInt(bracket.start_after_ns) + DURATION)],
      projected_cutoff_ns: String(at + PRIMARY) }, at);
    if (!passed) throw new Error('Warm-up, schedule horizon or clear routing ownership could not be established');
  }

  function invokeDeployment() {
    const running = driverLive();
    const invoked = ops.now();
    if (!running || invoked + PRIMARY > horizon) throw new Error('Workload horizon elapsed before deployment invocation');
    if (!postRollout) cutoff = invoked + PRIMARY;
    stage = 'DEPLOYMENT_INVOKED';
    let invocation;
    try { invocation = ops.deploy(arm); } catch (error) { invocation = Promise.reject(error); }
    deploymentInvoked = record('deployment_invoked', postRollout ? {} : {
      cutoff_ns: String(cutoff), fault_confirmation_id: confirmed.id
    }, invoked);
    if (!postRollout) {
      origin = deploymentInvoked;
      const breach = invoked - stamp(confirmed) > PREPARATION_TOLERANCE;
      record('preparation_tolerance_checked', { breached: breach, limit_ms: 5000, ...elapsed(confirmed, origin) }, invoked);
    }
    deployTask = deploymentResult(invocation);
    observerTask = observe();
  }

  try {
    record('preflight_passed', { evidence: await ops.preflight() });
    preflight = true;
    stage = 'DRIVER_STARTUP';
    const notification = Promise.withResolvers();
    const args = ['tools/driver/driver.js', '--url', url.href, '--rate', '5', '--duration', '120',
      '--warmup', '5', '--timeout', '3000', '--max-concurrency', '50', '--max-lateness', '200',
      '--out', directory, '--run-id', runId, '--notify-start'];
    const spawned = ops.now();
    record('driver_spawned', { args }, spawned);
    driver = ops.startDriver(args, payload => {
      const arrival = record('driver_start_notification_received', { payload });
      if (++notifications === 1) notification.resolve({ payload, arrival });
    });
    driverDone = driver.finished.then(raw => {
      const at = ops.now();
      driverExit = record('driver_finished', { execution: capture('driver', raw) }, at);
      admissionClosed = true;
      settlementDeadline = at + SETTLEMENT;
      stopMonitor();
      return null;
    });
    bracket = startClock(await untilOr(ops, spawned + STARTUP, Promise.race([notification.promise, driverDone])), spawned, runId);
    if (!bracket) throw new Error('Missing, late, or invalid Driver V1 startup notification');
    horizon = BigInt(bracket.start_before_ns) + DURATION;
    const warm = BigInt(bracket.start_after_ns) + WARMUP;
    await untilOr(ops, warm, driverDone);
    readiness(postRollout ? 'before_deployment' : 'before_fault', warm);
    if (postRollout) {
      const at = ops.now();
      const reserve = 5n * SECOND + postRollout.faultBudget + PRIMARY;
      if (at + reserve > horizon) {
        stageReason = 'measurement_coverage_failure';
        record('initial_fault_horizon_unavailable', { remaining_ns: String(horizon - at), required_ns: String(reserve) }, at);
        throw new Error('Initial schedule cannot cover settling, fault acknowledgment and the primary window');
      }
    }

    if (postRollout) {
      invokeDeployment();
      await untilOr(ops, horizon, Promise.race([deployTask, driverDone]));
      if (!driverLive()) stageReason = 'measurement_coverage_failure';
      else stageReason = await postRollout.prepare({
        ops, record, horizon, primary: PRIMARY, driverLive,
        waitFor: (deadline, other = new Promise(() => {})) =>
          untilOr(ops, deadline, Promise.race([other, driverDone])),
        verified: verification.promise, observerFinished: observerFinished.promise, samples, deployment,
        owns: () => owns(ops.routingState(), deployment?.deployment_id),
        monitorLive: () => arm === 'C' || Boolean(monitor && !monitorFinished && !monitorStatus),
        writeFault: async guard => {
          stage = 'FAULT_PREPARATION';
          faultAttempt = record('fault_write_requested', { role: 'candidate_fault_activation' });
          const raw = await ops.writePostRolloutFault(deployment.deployment_id, () => {
            const reason = guard();
            if (reason) return reason;
            faultInvoked = record('fault_command_invoked', { role: 'candidate_fault_activation', request_id: faultAttempt.id });
          });
          const received = ops.now();
          faultWrite = record('fault_command_returned', { action_id: faultInvoked?.id ?? null,
            execution: capture('fault-write', raw), refusal_reason: raw.reason ?? null }, received);
          if (!faultInvoked && raw.refused) return raw.reason === 'Candidate routing is no longer owned and installed'
            ? 'unsafe_routing' : raw.reason;
          const source = decimal(raw.writeStartedNs) ? BigInt(raw.writeStartedNs) : null;
          if (source !== null && faultInvoked && source >= stamp(faultInvoked) && source <= received) {
            faultStarted = record('fault_write_started', { action_id: faultInvoked.id,
              received_monotonic_ns: String(received) }, source);
          }
          if (!faultStarted || uncertainExecution(faultWrite.execution) || raw.exitCode !== 0) {
            stageReason = 'fault_acknowledgment_unverified';
            throw new Error('Fault write did not return a correlated acknowledgment');
          }
          cutoff = received + PRIMARY;
          faultAck = record('fault_write_acknowledged', { source_event_id: faultWrite.id,
            write_start_id: faultStarted.id, cutoff_ns: String(cutoff) }, received);
          origin = faultAck;
          stage = 'FAULT_ACKNOWLEDGED';
          if (cutoff > horizon || !driverLive()) stageReason = 'measurement_coverage_failure';
          evaluateAlertSamples();
          try {
            faultStateAfterWrite = record('candidate_fault_state_after_write', { state: await ops.faultState() });
          } catch (error) {
            faultStateAfterWrite = record('candidate_fault_state_after_write', { state: null, reason: message(error) });
          }
        }
      }) ?? stageReason;
      if (!origin) {
        stage = 'STAGE_NOT_REACHED';
        record('fault_stage_not_reached', { reason: stageReason });
      }
    } else {
      stage = 'FAULT_PREPARATION';
      faultAttempt = record('fault_write_requested', { role: 'candidate_fault_setup' });
      const raw = await ops.writeFault(() => {
        faultInvoked = record('fault_command_invoked', { role: 'candidate_fault_setup', request_id: faultAttempt.id });
      });
      const receipt = ops.now();
      faultWrite = record('fault_command_returned', { action_id: faultInvoked?.id ?? null, execution: capture('fault-write', raw) }, receipt);
      if (!faultInvoked || uncertainExecution(faultWrite.execution) || raw.exitCode !== 0) throw new Error('Candidate fault write was not acknowledged');
      faultAck = record('fault_write_acknowledged', { source_event_id: faultWrite.id }, receipt);

      const required = [['/api/work', 500], ['/health', 200], ['/ready', 200]];
      const confirmations = [];
      for (const [path, status] of required) {
        const started = ops.now();
        const result = await ops.candidateProbe(path);
        const received = ops.now();
        const source = decimal(result?.completed_monotonic_ns) ? BigInt(result.completed_monotonic_ns) : null;
        const correlated = source !== null && source >= started && source <= received;
        const probe = record('direct_candidate_precondition_probe', { path, observation: result,
          started_monotonic_ns: String(started), received_monotonic_ns: String(received),
          source_clock_correlated: correlated }, correlated ? source : received);
        confirmations.push({ probe, passed: correlated && result?.http_status === status &&
          (path !== '/api/work' || result.version === '2.0.0') });
      }
      if (confirmations.every(check => check.passed)) {
        const last = confirmations.at(-1).probe;
        confirmed = record('fault_independently_confirmed', { source_sample_ids: confirmations.map(check => check.probe.id) }, stamp(last));
      }
      const publicRoute = await ops.observe();
      stableBeforeDeploy = record('public_stable_precondition_probe', { observation: publicRoute });
      if (!confirmed || !stable(publicRoute)) throw new Error('Independent faulty candidate and stable public route preconditions failed');
      readiness('before_deployment', warm);
      invokeDeployment();
    }
    if (origin) {
      await ops.waitUntil(cutoff);
      primaryWaitComplete = true;
      record('primary_cutoff_observed', { cutoff_ns: String(cutoff) });
    }
    await driverDone;
  } catch (error) {
    executionError = record('runner_error', { stage, reason: message(error) });
    if (postRollout && !origin) {
      stageReason ??= stage === 'PREFLIGHT' ? 'environment_failure'
        : stage === 'FAULT_PREPARATION' ? 'fault_acknowledgment_unverified' : 'measurement_coverage_failure';
      stage = 'STAGE_NOT_REACHED';
      record('fault_stage_not_reached', { reason: stageReason });
    }
    if (postRollout ? !deploymentInvoked : !origin) driver?.stop();
  }

  await driverDone;
  admissionClosed = true;
  stopMonitor();
  stopObserver.abort();
  await observerTask;
  const operations = (async () => {
    await deployTask;
    await Promise.all([monitor?.finished, restoreTask]);
    return true;
  })();
  settlementDeadline ??= ops.now() + SETTLEMENT;
  const settled = await untilOr(ops, settlementDeadline, operations);
  operationsExpired = !settled;
  record('operations_settlement', { settled: settled === true, deadline_ns: String(settlementDeadline) });

  const workload = readWorkload(directory, runId);
  const run = workload.run.value;
  const clock = run?.clock_alignment;
  const clockMatches = Boolean(bracket && notifications === 1 && run?.run_id === runId && driverExit &&
    ['version', 'source', 'start_before_ns', 'start_after_ns'].every(key => bracket[key] === clock?.[key]) &&
    decimal(clock?.end_after_ns) && BigInt(clock.end_after_ns) <= stamp(driverExit));
  record('driver_clock_reconciliation', { passed: clockMatches });

  const primarySamples = cutoff === undefined ? [] : samples.filter(sample =>
    stamp(sample) < cutoff && (!postRollout || BigInt(sample.started_monotonic_ns) >= stamp(origin)));
  const observerCovered = Boolean(primaryWaitComplete && observerEnd && primarySamples.length &&
    stamp(observerEnd) >= cutoff && (!observerError || stamp(observerError) >= cutoff) &&
    samples.some(sample => BigInt(sample.started_monotonic_ns) < cutoff &&
      (BigInt(sample.started_monotonic_ns) + SECOND >= cutoff || stamp(sample) >= cutoff)));
  const rejected = deployment?.status === 'PROMOTION_BLOCKED' ? deployReturned : null;
  const lastPrimary = primarySamples.at(-1);
  const firstAfterCutoff = samples.find(sample => cutoff !== undefined && stamp(sample) >= cutoff);
  const continuity = observerCovered && firstAfterCutoff && stable(firstAfterCutoff.observation) &&
    lastPrimary && primarySamples.every(sample => stable(sample.observation))
    ? record('stable_continuity_verified', { source_sample_ids: [...primarySamples, firstAfterCutoff].map(sample => sample.id) },
      stamp(firstAfterCutoff)) : null;

  let lockedDetection;
  let thirdFailure;
  if (postRollout && arm === 'H' && deploymentInvoked) {
    const markers = monitorTimings.filter(receipt => {
      const { marker } = receipt;
      return decimal(marker?.occurred_monotonic_ns) && marker.deployment_id === deployment?.deployment_id &&
        BigInt(marker.occurred_monotonic_ns) >= stamp(deploymentInvoked) &&
        BigInt(marker.occurred_monotonic_ns) <= stamp(receipt);
    }).sort((a, b) => {
      const first = BigInt(a.marker.occurred_monotonic_ns);
      const second = BigInt(b.marker.occurred_monotonic_ns);
      return first < second ? -1 : first > second ? 1 : 0;
    });
    for (const receipt of markers) {
      const at = BigInt(receipt.marker.occurred_monotonic_ns);
      const fields = { source_event_id: receipt.id, source_observations: receipt.marker.source_observations ?? [],
        post_cutoff_action: cutoff !== undefined && at >= cutoff };
      if (receipt.marker.event === 'third_qualifying_failure' && !thirdFailure) {
        thirdFailure = record('monitor_third_failure', fields, at);
      }
      if (receipt.marker.event === 'locked_degradation_confirmed' && !lockedDetection) {
        lockedDetection = record('monitor_locked_confirmation', fields, at);
        if (faultStarted && at >= stamp(faultStarted)) {
          restore = record('automatic_restore_started', { ...fields, role: 'normal_workflow_restore',
            detection_event_id: lockedDetection.id, deployment_id: deployment.deployment_id }, at);
        }
      }
    }
  }

  let externalVerification;
  const stableStreak = [];
  if (restore) {
    for (const sample of samples) {
      if (BigInt(sample.started_monotonic_ns) < stamp(restore)) continue;
      if (!stable(sample.observation)) stableStreak.length = 0;
      else stableStreak.push(sample.id);
      if (stableStreak.length === 3) {
        externalVerification = record('external_restoration_verified', { role: 'external_verification',
          source_sample_ids: [...stableStreak], action_id: restore.id, recorded_monotonic_ns: String(ops.now()) }, stamp(sample));
        break;
      }
    }
  }

  const observedExposure = postRollout ? Boolean(origin && samples.some(sample =>
    stamp(sample) < cutoff && BigInt(sample.started_monotonic_ns) >= stamp(faultStarted) && faulty(sample.observation)))
    : primarySamples.some(sample => sample.observation?.version === '2.0.0');
  const switched = ['PROMOTED', 'SWITCHED'].includes(deployment?.status);
  const reportsRollback = postRollout && arm === 'H' && monitorReports.some(report =>
    ['ROLLED_BACK', 'ROLLBACK_FAILED', 'FINALIZATION_FAILED'].includes(report.outcome?.status));
  const knownActionAbsence = arm === 'C' ? observerCovered && !ownershipUncertain && settled
    : monitorStatus?.outcome?.status === 'ADMISSION_CLOSED' && !reportsRollback && !ownershipUncertain && settled;
  const preFaultWorkflowOutcome = ['deployment_failure', 'workflow_time_budget_exceeded',
    'candidate_service_regressed'].includes(stageReason);
  const actionAttribution = !postRollout || !lockedDetection || Boolean(restore);
  const inputs = { scenario, arm, origin, intervention: null,
    ...(postRollout && { deployment: deploymentInvoked, faultWriteStarted: faultStarted }),
    restore: restore ?? (knownActionAbsence && actionAttribution ? null : undefined),
    exposureConfirmed: observedExposure, recoveryApplicable: postRollout
      ? origin ? true : preFaultWorkflowOutcome ? false : undefined
      : switched || observedExposure ? true : undefined,
    prevention: { rejected, stableContinuity: continuity }, externalVerification, expectedTargetUrl: url.href };
  const classify = () => classifyWorkflowClient({ ...inputs, run, requests: workload.requests.value });
  let classification = classify();
  const candidateIds = classification.accounting.candidate ?? [];
  const observedClientExposure = postRollout ? (classification.accounting.candidateFailed ?? []).some(seq =>
    classification.trace.rows?.[seq - 1]?.status === 500) : candidateIds.length > 0;
  if (observedClientExposure && !inputs.exposureConfirmed) {
    inputs.exposureConfirmed = true;
    inputs.recoveryApplicable = true;
    classification = classify();
  } else if (!postRollout && arm === 'C' && deployment?.status === 'FAILED' && continuity &&
      !observedExposure && classification.accounting.completeness === 'complete' &&
      classifyStableCohort(classification)) {
    inputs.recoveryApplicable = false;
    classification = classify();
  }
  let supportingPreFaultInputs;
  if (postRollout && !origin && deploymentInvoked && classification.candidate.primary.status === 'insufficient_evidence') {
    // Preserve the approved deployment metric independently of an unverified fault stage.
    supportingPreFaultInputs = { ...inputs, recoveryApplicable: false };
    classification.candidate = classifyWorkflowClient({
      ...supportingPreFaultInputs, run, requests: workload.requests.value
    }).candidate;
  }
  const files = Object.fromEntries(Object.entries(workload).map(([key, { value, ...ref }]) => [key, ref]));
  save('classifier.json', JSON.stringify({ inputs, supportingPreFaultInputs, files, result: classification }, null, 2) + '\n');

  let cleanup = { status: 'blocked' };
  let reset = { status: 'unverified' };
  if (preflight && settled && (!origin || primaryWaitComplete)) {
    try {
      // Inspect even after a lost write acknowledgement. Do not race a possibly still pending remote exec.
      const flag = faultInvoked ? await ops.faultState() : null;
      if (faultInvoked) record('candidate_fault_state_before_cleanup', { state: flag });
      const state = ops.routingState();
      record('routing_before_cleanup', { state });
      if (ownershipUncertain || (faultInvoked && !faultAck && (!faultWrite || uncertainExecution(faultWrite.execution) || flag?.present !== false))) {
        throw new Error('Uncertain controller or fault write effects require manual reconciliation');
      }
      if (faultInvoked && typeof flag?.present !== 'boolean') throw new Error('Candidate fault state is unverified');
      if (!unowned(state)) {
        const owner = state.deployment_id ?? state.pending_deployment_id;
        if (!owner || owner !== deployment?.deployment_id ||
            (state.deployment_id !== null && state.pending_deployment_id !== null)) {
          throw new Error('Routing owner cannot be attributed to this trial');
        }
        const action = record('cleanup_restore_invoked', { role: 'cleanup_restore', deployment_id: owner });
        let raw;
        try {
          const result = await ops.restore(arm, owner, execution => { raw = execution; });
          if (raw && controllerResult(raw, 'C', true)?.status !== 'RESTORED') throw new Error('Unverified cleanup restore result');
          record('cleanup_restore_returned', { action_id: action.id, outcome: result });
        } finally {
          if (raw) record('cleanup_restore_execution', { action_id: action.id, execution: capture('cleanup-restore', raw) });
        }
      }
      if (faultAck && !flag.present && origin) {
        throw new Error('Acknowledged candidate fault was cleared before runner cleanup');
      }
      if (faultAck) {
        await ops.verifyStableForFaultClear();
        const clearAction = record('cleanup_fault_clear_invoked', { role: 'cleanup' });
        const cleared = await ops.clearFault();
        const result = record('cleanup_fault_clear_returned', { action_id: clearAction.id, execution: capture('fault-clear', cleared) });
        const actual = await ops.faultState();
        record('candidate_fault_state_after_cleanup', { state: actual });
        if (uncertainExecution(result.execution) || cleared.exitCode !== 0 || actual?.present !== false) {
          throw new Error('Candidate fault clearance could not be established');
        }
      }
      cleanup = { status: 'completed' };
    } catch (error) {
      cleanup = { status: 'blocked_or_failed', event: record('cleanup_blocked_or_failed', { reason: message(error) }) };
    }
    if (cleanup.status === 'completed') {
      try {
        reset = { status: 'verified', event: record('reset_verified', { evidence: await ops.reset() }) };
      } catch (error) {
        reset = { status: 'failed', event: record('reset_failed', { reason: message(error) }) };
      }
    }
  }

  const confirmationToDeployment = elapsed(confirmed, origin);
  const toleranceBreached = confirmationToDeployment !== null && BigInt(confirmationToDeployment.elapsed_ns) > PREPARATION_TOLERANCE;
  const primaryCovered = Boolean(clockMatches && classification.window?.observedThrough &&
    BigInt(classification.window.observedThrough[0]) >= cutoff);
  const setupInvalid = !preflight || !clockMatches || classification.configuration.status !== 'compliant' ||
    (!origin && (!postRollout || (!preFaultWorkflowOutcome && stageReason !== 'observer_coverage_failure'))) ||
    (postRollout && ['unsafe_routing', 'unsafe_fault_state', 'fault_acknowledgment_unverified'].includes(stageReason));
  const measuredAbsence = Boolean(origin && primaryCovered && knownActionAbsence);
  const detection = postRollout && (!origin && !preFaultWorkflowOutcome ? { status: 'insufficient_evidence' }
    : postRollout.detection(arm === 'H' ? lockedDetection : alert, faultStarted, faultAck, cutoff, measuredAbsence));
  const missingMonitorTiming = reportsRollback && !lockedDetection;
  const restored = restoreReturned?.outcome?.status === 'RESTORED' ? restoreReturned
    : monitorReports.find(event => event.outcome?.status === 'ROLLED_BACK');
  const routeTiming = switched ? {
    candidate_installation: { earliest_event: deploymentInvoked, latest_event: deployReturned },
    stable_restoration: restore && restored ? { earliest_event: restore, latest_event: restored } : null,
    ownership_sample: deployedOwnership ?? null
  } : null;
  const issues = [
    ...(setupInvalid ? ['setup_or_clock_invalid'] : []),
    ...(toleranceBreached ? ['preparation_tolerance_breached'] : []),
    ...((!postRollout || origin) && (!primaryCovered || classification.accounting.completeness !== 'complete')
      ? ['client_coverage_incomplete'] : []),
    ...((!postRollout || origin) && !observerCovered || stageReason === 'observer_coverage_failure'
      ? ['observer_coverage_incomplete'] : []),
    ...(missingMonitorTiming ? ['monitor_timing_missing'] : []),
    ...(origin && stageReason === 'measurement_coverage_failure' ? ['post_fault_coverage_not_established'] : []),
    ...(detection?.status === 'attribution_review' ? ['detection_precedes_fault_write'] : []),
    ...(postRollout && origin && faultStateAfterWrite?.state?.present !== true ? ['fault_state_after_ack_unverified'] : []),
    ...(driverExit && (driverExit.execution.exit_code !== 0 || classification.execution.status !== 'complete')
      ? ['driver_execution_not_complete'] : []),
    ...(!deployment || !settled || ownershipUncertain || (arm === 'H' && switched && !monitorStatus)
      ? ['workflow_evidence_incomplete'] : [])
  ];
  const clientFirstCandidate = classification.candidate.firstSuccess?.completion?.[1];
  const preFaultClientRegressions = postRollout && clientFirstCandidate ? (classification.trace.rows ?? [])
    .filter(row => row.dispatch_time && row.completion_time &&
      BigInt(row.dispatch_time[0]) >= BigInt(clientFirstCandidate) &&
      (!faultStarted || BigInt(row.completion_time[1]) < stamp(faultStarted)) &&
      !(row.outcome === 'ok' && row.status === 200 && row.version === '2.0.0'))
    .map(row => row.seq) : [];
  const result = {
    scenario, arm, trialId, runId, directory, stage, origin,
    ...(postRollout && { deployment_invocation: deploymentInvoked ?? null, fault_stage_reason: stageReason ?? null,
      candidate_verified: candidateVerified ?? null, fault_write_started: faultStarted ?? null,
      fault_state_after_write: faultStateAfterWrite ?? null, fault_write_bracket: elapsed(faultStarted, faultAck),
      trigger_admission_end_ns: horizon === undefined ? null : String(horizon) }),
    execution: { status: executionError ? 'incomplete' : 'completed', error: executionError ?? null,
      driver: driverExit ?? null, deployment: deployReturned ?? null, operations_settled: settled === true },
    preparation: postRollout ? {
      status: faultAck ? (faultStateAfterWrite?.state?.present === true ? 'active_verified'
        : 'acknowledged_state_unverified')
        : !faultInvoked ? 'stage_not_reached'
        : !faultWrite || uncertainExecution(faultWrite.execution) || faultWrite.execution.exit_code === 0
          ? 'write_ack_uncertain' : 'write_failed',
      request: faultAttempt ?? null,
      invocation: faultInvoked ?? null,
      write: faultWrite ?? null,
      write_start: faultStarted ?? null,
      acknowledgment: faultAck ?? null,
      active_flag_observation: faultStateAfterWrite ?? null,
      deployment_to_acknowledgment: elapsed(deploymentInvoked, faultAck)
    } : { status: !preflight ? 'environment_failed' : !faultAttempt ? 'not_started' : !faultInvoked ? 'environment_failed'
      : !faultAck ? (!faultWrite || uncertainExecution(faultWrite.execution) ? 'write_ack_uncertain' : 'write_failed')
      : confirmed && stable(stableBeforeDeploy?.observation) ? 'confirmed' : 'confirmation_failed',
    request: faultAttempt ?? null, invocation: faultInvoked ?? null, write: faultWrite ?? null, acknowledgment: faultAck ?? null,
    confirmation: confirmed ?? null, stable_public_probe: stableBeforeDeploy ?? null,
    acknowledgment_to_confirmation: elapsed(faultAck, confirmed), confirmation_to_deployment: confirmationToDeployment,
    acknowledgment_to_deployment: elapsed(faultAck, origin), tolerance_breached: toleranceBreached },
    workflow: { deployment: deployment?.status ?? (deploymentInvoked ? 'UNKNOWN' : 'NOT_INVOKED'),
      prevention: classification.prevention, route_timing_bounds: routeTiming, public_candidate_request_ids: candidateIds,
      public_candidate_failed_request_ids: classification.accounting.candidateFailed ?? [],
      public_candidate_observer_sample_ids: samples.filter(sample => sample.observation?.version === '2.0.0').map(sample => sample.id),
      promotion_rejection_latency: elapsed(deploymentInvoked, rejected), alert: alert ?? null,
      ...(!postRollout && { primary_deployment_to_alert: alert && stamp(alert) < cutoff
        ? elapsed(deploymentInvoked, alert) : null }),
      deployment_to_alert: elapsed(deploymentInvoked, alert), fault_ack_to_alert: elapsed(faultAck, alert),
      alert_to_restore: elapsed(alert, restore), restore: restore ?? null,
      restore_outcome: restoreReturned ?? null, monitor_status: monitorStatus ?? null,
      monitor_reports: monitorReports, monitor_timings: monitorTimings, recovery: classification.recovery,
      ...(postRollout && { detection, monitor_execution: monitorFinished ?? null, third_failure: thirdFailure ?? null, locked_confirmation: lockedDetection ?? null,
        client_candidate_regressions_before_fault: preFaultClientRegressions,
        candidate_regressions_before_fault: samples.filter(sample => candidateVerified && stamp(sample) > stamp(candidateVerified) &&
          (!faultStarted || stamp(sample) < stamp(faultStarted)) &&
          !(sample.observation?.http_status === 200 && sample.observation.version === '2.0.0')).map(sample => sample.id) }) },
    observer: { primary_covered: observerCovered, error: observerError ?? null, end: observerEnd ?? null,
      stable_verification: externalVerification ?? null },
    metrics: { client_coverage: { primary_covered: primaryCovered, clock_matches: clockMatches,
      window: classification.window ?? null, followup: classification.followup ?? null },
    request_accounting: classification.accounting.completeness,
    recovery: classification.recovery.primary.status,
    recovery_completeness: classification.recovery.primary.completeness ??
      (classification.recovery.primary.status === 'not_applicable' ? 'not_applicable' : 'insufficient'),
    external_verification: externalVerification ? 'observed' : observerCovered ? 'not_observed' : 'insufficient',
    ...(postRollout && { approved_measures: {
      failure_detection_time: detection,
      recovery_time: { status: classification.recovery.primary.status,
        milestone: classification.recovery.primary.milestone },
      observed_downtime: { status: !origin && preFaultWorkflowOutcome ? 'not_applicable' : classification.episodes.completeness,
        source: 'classifier.json#result.episodes' },
      failed_requests: { status: !origin && preFaultWorkflowOutcome ? 'not_applicable' : classification.accounting.completeness,
        source: 'classifier.json#result.accounting' },
      recovery_success: classification.recovery.primary.status,
      deployment_overhead: { role: 'pre_fault_supporting', ...classification.candidate.primary,
        first_success: classification.candidate.firstSuccess ?? null }
    } }) },
    validity: { status: setupInvalid ? 'invalid' : issues.length ? 'needs_review' : 'valid', issues },
    cleanup, reset, nextArmAllowed: reset.status === 'verified', classifier: 'classifier.json'
  };
  save('summary.json', JSON.stringify(result, null, 2) + '\n');
  return result;
}

function classifyStableCohort(classification) {
  return classification.accounting.dispatched.length > 0 && classification.accounting.dispatched.every(seq => {
    const row = classification.trace.rows[seq - 1];
    return row.outcome === 'ok' && row.status === 200 && row.version === '1.0.0';
  });
}

function faultyCandidateAdapters(frozen, postRolloutBudget) {
  const base = liveAdapters(frozen);
  const candidateExec = args => command('docker',
    ['compose', '--profile', 'routing', 'exec', '-T', 'candidate', ...args], 10_000);
  const faultCommand = script => candidateExec(['sh', '-eu', '-c',
    'test -n "$WORKLOAD_FAULT_FILE"; ' + script]);
  const probe = `
    const path = process.argv[1];
    try {
      const reply = await fetch('http://127.0.0.1:3000' + path,
        { signal: AbortSignal.timeout(1500), redirect: 'manual' });
      const body = await reply.json();
      console.log(JSON.stringify({ http_status: reply.status, version: body?.version ?? null,
        completed_monotonic_ns: process.hrtime.bigint().toString() }));
    } catch (error) {
      console.log(JSON.stringify({ http_status: null, error: error.message,
        completed_monotonic_ns: process.hrtime.bigint().toString() }));
    }
  `;
  async function verifyStable() {
    const { configPath } = await import('../controller/nginx-routing.mjs');
    const digest = createHash('sha256').update(await readFile(configPath)).digest('hex');
    if (!unowned(base.routingState()) || digest !== frozen.stableConfigSha256 || !stable(await base.observe())) {
      throw new Error('Candidate fault changes require a verified unowned stable route');
    }
  }
  async function changeFault(script, onInvoke) {
    const { withRoutingLock } = await import('../controller/deployment-state.mjs');
    return withRoutingLock(async () => {
      await verifyStable();
      onInvoke?.();
      return faultCommand(script);
    });
  }
  return {
    ...base,
    ...(postRolloutBudget && { async writePostRolloutFault(owner, onInvoke) {
      const { readDeployment } = await import('../controller/deployment-state.mjs');
      const { readRuntimeConfig } = await import('../controller/nginx-routing.mjs');
      if (!owns(base.routingState(), owner) || !readRuntimeConfig().equals(readDeployment(owner).candidate)) {
        return { refused: true, reason: 'Candidate routing is no longer owned and installed' };
      }
      const reason = onInvoke();
      if (reason) return { refused: true, reason };
      const script = `
        import { closeSync, openSync } from 'node:fs';
        const file = process.env.WORKLOAD_FAULT_FILE;
        if (!file) throw new Error('Candidate fault file is not configured');
        const writeStartedNs = process.hrtime.bigint().toString();
        console.log(JSON.stringify({ writeStartedNs }));
        closeSync(openSync(file, 'wx'));
      `;
      const result = await command('docker', ['compose', '--profile', 'routing', 'exec', '-T', 'candidate',
        'node', '--input-type=module', '-e', script], Number(postRolloutBudget / 1_000_000n));
      let writeStartedNs;
      try { ({ writeStartedNs } = JSON.parse(result.stdout)); } catch { /* retain raw command evidence */ }
      return { ...result, writeStartedNs };
    } }),
    writeFault: onInvoke => changeFault('set -C; : > "$WORKLOAD_FAULT_FILE"', onInvoke),
    clearFault: () => changeFault('rm -f -- "$WORKLOAD_FAULT_FILE"; test ! -e "$WORKLOAD_FAULT_FILE"'),
    async faultState() {
      const result = await faultCommand('if test -e "$WORKLOAD_FAULT_FILE"; then echo present; else echo absent; fi');
      const value = result.stdout.trim();
      return { present: result.exitCode === 0 && ['present', 'absent'].includes(value) ? value === 'present' : null,
        exit_code: result.exitCode, signal: result.signal, error: result.error };
    },
    async candidateProbe(path) {
      const result = await candidateExec(['node', '--input-type=module', '-e', probe, path]);
      if (result.exitCode !== 0) return { http_status: null, error: result.error, stderr: result.stderr };
      try { return JSON.parse(result.stdout); }
      catch { return { http_status: null, error: 'Malformed candidate probe output', stdout: result.stdout }; }
    },
    verifyStableForFaultClear: verifyStable
  };
}
