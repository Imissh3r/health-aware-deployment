const thresholds = Object.freeze({
  cutoffOffsetMs: 60_000,
  maxProbeCompletionLatenessMs: 200,
  maxClockDivergenceMs: 20,
  maxClockSampleGapMs: 1000
});
const requestsPerSecond = 5;
const requestIntervalMs = 1000 / requestsPerSecond;
const offeredRequests = thresholds.cutoffOffsetMs / requestIntervalMs;
const targetUrl = 'http://127.0.0.1:8080/api/work';
const stableVersion = '1.0.0';
const candidateVersion = '2.0.0';
const requiredServices = ['db', 'app', 'candidate', 'nginx'];
const invariantNames = [
  'offered_accounted', 'dispatched_settled', 'record_count_and_sequence', 'missed_reasons_accounted'
];
const outcomes = ['ok', 'http_error', 'timeout', 'connection_error', 'driver_error', 'interrupted', 'missed'];
const timingEvents = new Set(['promotion_verified', 'driver_started', 'fault_activated', 'recovery_verified']);
const showsVerification = new Set(['ROLLED_BACK', 'FINALIZATION_FAILED']);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
const nonempty = value => typeof value === 'string' && value.trim() !== '';
const assessment = (status, ...reasonCodes) => ({ status, reasonCodes });

function assessWorkload(trial, driver, requests) {
  const unusable = () => assessment('unusable', 'WORKLOAD_EVIDENCE_INVALID');
  const options = driver?.options;
  if (!nonempty(trial?.trial_id) || driver?.run_id !== trial.trial_id ||
      driver.status !== 'complete' || driver.review_required !== false ||
      !timestamp(driver.wall_start_ms) || driver.target_url !== targetUrl ||
      options?.rate !== requestsPerSecond || options.duration_seconds !== thresholds.cutoffOffsetMs / 1000 ||
      options.timeout_ms !== 3000 || options.warmup_seconds !== 5 ||
      options.max_concurrency !== 50 || options.max_lateness_ms !== 200 ||
      !invariantNames.every(name => driver.invariants?.[name] === true) ||
      !Array.isArray(requests) || requests.length !== offeredRequests) {
    return unusable();
  }

  const counts = Object.fromEntries(outcomes.map(outcome => [outcome, 0]));
  const missed = { late: 0, concurrency: 0 };
  for (const [index, row] of requests.entries()) {
    if (row?.run_id !== driver.run_id || row.seq !== index + 1 ||
        row.scheduled_ms !== index * requestIntervalMs || !Object.hasOwn(counts, row.outcome)) {
      return unusable();
    }
    counts[row.outcome]++;
    if (row.outcome === 'missed') {
      if (!Object.hasOwn(missed, row.miss_reason)) return unusable();
      missed[row.miss_reason]++;
    } else if (!Number.isFinite(row.completed_ms) || row.completed_ms < row.scheduled_ms ||
        (row.outcome === 'ok' && (!Number.isFinite(row.latency_ms) || row.latency_ms < 0))) {
      return unusable();
    }
  }

  const dispatched = offeredRequests - counts.missed;
  const summary = driver.summary;
  if (summary?.offered !== offeredRequests || summary.dispatched !== dispatched ||
      summary.settled !== dispatched || summary.missed !== counts.missed ||
      !outcomes.every(outcome => summary.outcomes?.[outcome] === counts[outcome]) ||
      !Object.keys(missed).every(reason => summary.missed_by_reason?.[reason] === missed[reason]) ||
      counts.driver_error !== 0 || counts.interrupted !== 0) {
    return unusable();
  }
  return assessment('usable');
}

function readTrialEvents(trial, events) {
  const times = new Map();
  let conflict = false;
  for (const row of Array.isArray(events) ? events : []) {
    if (!timingEvents.has(row?.event)) continue;
    if (row.trial_id !== trial?.trial_id || row.arm !== trial?.arm ||
        !timestamp(row.wall_ms) || times.has(row.event)) {
      conflict = true;
      continue;
    }
    times.set(row.event, row.wall_ms);
  }
  return { times, conflict };
}

function assessAttempt(trial, eventTimes, workloadUsability) {
  const checks = trial?.checks;
  const servicesReady = requiredServices.every(service => {
    const containers = checks?.services?.[service];
    const container = containers?.[0];
    return Array.isArray(containers) && containers.length === 1 && container?.state === 'running' &&
      (container.health === 'healthy' || (service === 'nginx' && container.health === null));
  });
  const reasons = [];
  if (trial?.event !== 'paired_pilot' || trial.preflight_only !== false ||
      !['A', 'B'].includes(trial.arm) || !nonempty(trial.deployment_id) ||
      !eventTimes.has('promotion_verified') ||
      checks?.routing_state?.deployment_id !== null || checks.routing_state.pending_deployment_id !== null ||
      !Array.isArray(checks.config_upstreams) ||
      checks.config_upstreams.length !== 1 || checks.config_upstreams[0] !== 'http://app:3000' || !servicesReady ||
      checks.candidate_fault_flag !== 'absent' ||
      checks.proxy?.http_status !== 200 || checks.proxy.version !== stableVersion ||
      !Array.isArray(trial.failures) ||
      trial.failures.some(failure => failure?.step === 'preflight' || failure?.step === 'promotion')) {
    reasons.push('SETUP_INVALID');
  }
  if (!eventTimes.has('fault_activated')) reasons.push('FAULT_NOT_ACKNOWLEDGED');
  reasons.push(...workloadUsability.reasonCodes);
  return assessment(reasons.length ? 'invalid' : 'valid', ...reasons);
}

function assessClock(samples, start, cleanup) {
  if (samples == null || (Array.isArray(samples) && samples.length === 0)) {
    return assessment('not_collected', 'CLOCK_TRACE_MISSING');
  }
  if (!Array.isArray(samples) || Array.from(samples).some((sample, index) =>
    !timestamp(sample?.wall_ms) || !Number.isFinite(sample.monotonic_ms) || sample.monotonic_ms < 0 ||
    (index > 0 && sample.monotonic_ms <= samples[index - 1].monotonic_ms))) {
    return assessment('invalid', 'CLOCK_SAMPLE_INVALID');
  }
  if (!timestamp(start) || !timestamp(cleanup) || cleanup <= start) {
    return assessment('invalid', 'CLOCK_BRACKET_MISSING');
  }
  const first = samples.findIndex(sample => sample.wall_ms > start) - 1;
  const last = samples.findIndex((sample, index) => index > first && sample.wall_ms >= cleanup);
  if (first < 0 || last < 0) return assessment('invalid', 'CLOCK_BRACKET_MISSING');

  const origin = samples[first];
  let minimum = 0;
  let maximum = 0;
  let maxGap = 0;
  for (let index = first + 1; index <= last; index++) {
    const sample = samples[index];
    const previous = samples[index - 1];
    const gap = sample.monotonic_ms - previous.monotonic_ms;
    if (sample.wall_ms < previous.wall_ms) {
      return assessment('invalid', 'CLOCK_SAMPLE_INVALID');
    }
    maxGap = Math.max(maxGap, gap);
    const offset = (sample.wall_ms - origin.wall_ms) - (sample.monotonic_ms - origin.monotonic_ms);
    minimum = Math.min(minimum, offset);
    maximum = Math.max(maximum, offset);
  }
  const divergenceMs = maximum - minimum;
  const reasons = [];
  if (maxGap > thresholds.maxClockSampleGapMs) reasons.push('CLOCK_GAP_EXCEEDED');
  if (divergenceMs > thresholds.maxClockDivergenceMs) reasons.push('CLOCK_DIVERGENCE_EXCEEDED');
  return {
    ...assessment(reasons.length ? 'invalid' : 'valid', ...reasons),
    divergenceMs,
    maxSampleGapMs: maxGap
  };
}

function readRecovery(controller, deploymentId) {
  if (controller == null || (Array.isArray(controller) && controller.length === 0)) {
    return { ...assessment('unverified', 'RECOVERY_EVIDENCE_MISSING'), verifiedAtMs: null };
  }
  if (!Array.isArray(controller) || Array.from(controller).some(record => !nonempty(record?.status))) {
    return { ...assessment('untrusted', 'RECOVERY_EVIDENCE_MALFORMED'), verifiedAtMs: null };
  }
  const terminal = controller.at(-1);
  const recovery = terminal.recovery;
  const reportedTime = recovery?.verified_at;
  const parsedTime = typeof reportedTime === 'string' ? Date.parse(reportedTime) : NaN;
  const verifiedAtMs = timestamp(parsedTime) ? parsedTime : null;
  if (!nonempty(deploymentId) || controller.some(record => record.deployment_id !== deploymentId) ||
      controller.slice(0, -1).some(record => showsVerification.has(record.status))) {
    return { ...assessment('untrusted', 'EVIDENCE_CONFLICT'), verifiedAtMs };
  }
  if (!showsVerification.has(terminal.status)) {
    if (recovery?.proxy_verified === true || reportedTime != null) {
      return { ...assessment('untrusted', 'EVIDENCE_CONFLICT'), verifiedAtMs };
    }
    return { ...assessment('unverified'), verifiedAtMs: null };
  }
  if (reportedTime == null) {
    return { ...assessment('unverified', 'RECOVERY_EVIDENCE_MISSING'), verifiedAtMs: null };
  }
  if (verifiedAtMs === null || new Date(verifiedAtMs).toISOString() !== reportedTime ||
      recovery.proxy_verified !== true || recovery.verification?.passed !== true ||
      recovery.verification.consecutive !== 3 || recovery.last_proxy_observation?.http_status !== 200 ||
      recovery.last_proxy_observation?.version !== stableVersion) {
    return { ...assessment('untrusted', 'RECOVERY_EVIDENCE_MALFORMED'), verifiedAtMs };
  }
  return { ...assessment('verified'), verifiedAtMs };
}

function assessRecovery(record, observation, timeline, clockIntegrity) {
  const { verifiedAtMs } = record;
  const unresolved = { ...record, timing: null };
  if (record.status === 'untrusted' || record.reasonCodes.includes('RECOVERY_EVIDENCE_MISSING')) return unresolved;
  const { cutoff, cleanup, interruptedAt, eventVerification, faultAt, faultInWindow, conflict } = timeline;
  const ordered = faultInWindow && timestamp(cleanup) &&
    verifiedAtMs !== null && verifiedAtMs >= faultAt && verifiedAtMs <= cleanup &&
    (interruptedAt === null || verifiedAtMs <= interruptedAt);
  // Match the runner's flag before applying the independent clock-integrity check.
  const inWindow = ordered && verifiedAtMs < cutoff;
  if (conflict || (Object.hasOwn(observation, 'verified_at_ms') && observation.verified_at_ms !== verifiedAtMs) ||
      (eventVerification !== undefined && eventVerification !== verifiedAtMs) ||
      (typeof observation.recovery_verified_in_window === 'boolean' &&
        observation.recovery_verified_in_window !== inWindow)) {
    return { ...assessment('untrusted', 'EVIDENCE_CONFLICT'), verifiedAtMs, timing: null };
  }
  if (record.status !== 'verified') return unresolved;
  if (clockIntegrity.status !== 'valid') {
    return { ...unresolved, reasonCodes: [...clockIntegrity.reasonCodes] };
  }
  if (!ordered) return { ...unresolved, reasonCodes: ['RECOVERY_OUTSIDE_TRIAL'] };
  if (eventVerification === undefined || !Object.hasOwn(observation, 'verified_at_ms') ||
      typeof observation.recovery_verified_in_window !== 'boolean') {
    return { ...unresolved, reasonCodes: ['RECOVERY_EVIDENCE_MISSING'] };
  }
  return {
    ...assessment('verified', inWindow ? 'VERIFIED_BEFORE_CUTOFF' : 'VERIFIED_AT_OR_AFTER_CUTOFF'),
    verifiedAtMs,
    timing: inWindow ? 'in_window' : 'late'
  };
}

function assessProbe(observation, timeline, clockIntegrity) {
  const probe = observation.final_observation;
  if (probe == null) return assessment('not_collected', 'PROBE_NOT_COLLECTED');
  const { started_at_ms: start, completed_at_ms: end, http_status: status, error } = probe;
  if (error != null || !Number.isInteger(status) || status < 100 || status > 599) {
    return assessment('unusable', 'PROBE_FAILED');
  }
  if (clockIntegrity.status !== 'valid') return assessment('unusable', ...clockIntegrity.reasonCodes);
  const { cutoff, cleanup, interruptedAt, conflict } = timeline;
  if (conflict || (timestamp(start) && cutoff !== null &&
      Object.hasOwn(observation, 'final_observation_lateness_ms') &&
      observation.final_observation_lateness_ms !== start - cutoff)) {
    return assessment('unusable', 'EVIDENCE_CONFLICT');
  }
  // The runner awaits the probe before starting cleanup, so recorded times can tie.
  if (!timestamp(start) || !timestamp(end) || !timestamp(cleanup) || cutoff === null ||
      start < cutoff || end < start || end > cutoff + thresholds.maxProbeCompletionLatenessMs || end > cleanup) {
    return assessment('unusable', 'PROBE_OUTSIDE_WINDOW');
  }
  if (interruptedAt !== null && interruptedAt <= end) return assessment('unusable', 'PROBE_INTERRUPTED');
  return assessment('usable');
}

function qualifiedRollbackFailure(terminal, monitorProcess) {
  return terminal?.status === 'ROLLBACK_FAILED' && terminal.recovery?.proxy_verified === false &&
    nonempty(terminal.recovery.failed_step) && nonempty(terminal.recovery.reason) &&
    monitorProcess?.exit_code === 1 && monitorProcess.signal == null && monitorProcess.error == null &&
    monitorProcess.stop_reason == null && monitorProcess.stop_requested_at_ms == null;
}

function classifyCutoff({ attemptValidity, clockIntegrity, recoveryEvidence, probeUsability,
  timeline, terminal, monitorProcess, observation }) {
  const blocked = [...new Set([
    ...attemptValidity.reasonCodes,
    ...clockIntegrity.reasonCodes,
    ...(timeline.conflict ? ['EVIDENCE_CONFLICT'] : []),
    ...(!timeline.faultInWindow && timeline.faultAt !== undefined ? ['FAULT_OUTSIDE_WINDOW'] : []),
    ...(recoveryEvidence.status === 'untrusted' ? recoveryEvidence.reasonCodes : [])
  ])];
  if (blocked.length > 0) return assessment('unknown', ...blocked);
  if (recoveryEvidence.timing === 'in_window') return assessment('recovered_in_window', 'VERIFIED_BEFORE_CUTOFF');
  if (recoveryEvidence.reasonCodes.length > 0) return assessment('unknown', ...recoveryEvidence.reasonCodes);
  if (probeUsability.status !== 'usable') return assessment('unknown', ...probeUsability.reasonCodes);

  const probe = observation.final_observation;
  if (probe.http_status === 500 && probe.version === candidateVersion &&
      observation.runner_cleanup_deferred_through_cutoff === true &&
      qualifiedRollbackFailure(terminal, monitorProcess)) {
    return assessment('not_recovered_by_cutoff', 'CANDIDATE_500_NEAR_CUTOFF');
  }
  return assessment('unknown', 'NO_DECISIVE_CUTOFF_EVIDENCE');
}

// CSV rows use parsed numeric fields. Controller records and clock samples use recorded order.
// A loader can represent an unparseable record with null to retain the error.
export function classifyTrialEvidence({ trial, driver, requests, events, controller, clockSamples } = {}) {
  const observation = trial?.observation ?? {};
  const { times, conflict } = readTrialEvents(trial, events);
  const start = driver?.wall_start_ms;
  const cutoff = timestamp(start) && timestamp(start + thresholds.cutoffOffsetMs)
    ? start + thresholds.cutoffOffsetMs : null;
  const faultAt = times.get('fault_activated');
  const eventStart = times.get('driver_started');
  const timeline = {
    cutoff,
    faultAt,
    faultInWindow: cutoff !== null && timestamp(faultAt) && faultAt >= start && faultAt < cutoff,
    cleanup: observation.cleanup_started_ms,
    interruptedAt: observation.interrupted_at_ms ?? null,
    eventVerification: times.get('recovery_verified'),
    conflict: conflict || (eventStart !== undefined && eventStart !== start) ||
      (observation.cutoff_ms != null && observation.cutoff_ms !== cutoff) ||
      (observation.interrupted_at_ms != null && !timestamp(observation.interrupted_at_ms))
  };
  const workloadUsability = assessWorkload(trial, driver, requests);
  const attemptValidity = assessAttempt(trial, times, workloadUsability);
  const clockIntegrity = assessClock(clockSamples, start, timeline.cleanup);
  const controllerRecord = readRecovery(controller, trial?.deployment_id);
  const recoveryEvidence = assessRecovery(controllerRecord, observation, timeline, clockIntegrity);
  const probeUsability = assessProbe(observation, timeline, clockIntegrity);
  const terminal = Array.isArray(controller) ? controller.at(-1) : null;
  const cutoffOutcome = classifyCutoff({
    attemptValidity, clockIntegrity, recoveryEvidence, probeUsability, timeline,
    terminal, monitorProcess: trial?.monitor_process, observation
  });
  const reviewFlags = [];
  const probe = observation.final_observation;
  if (probeUsability.status === 'usable') {
    if (recoveryEvidence.timing === 'in_window' &&
        probe.http_status === 500 && probe.version === candidateVersion) {
      reviewFlags.push('POST_VERIFICATION_CANDIDATE_500');
    }
    if (probe.http_status === 200 && probe.version === stableVersion) reviewFlags.push('PROBE_STABLE_AT_CUTOFF');
  }
  return {
    classifierVersion: '1',
    thresholds: { ...thresholds },
    attemptValidity,
    workloadUsability,
    clockIntegrity,
    probeUsability,
    cutoffOutcome,
    recoveryEvidence,
    controllerStatus: nonempty(terminal?.status) ? terminal.status : null,
    reviewFlags
  };
}
