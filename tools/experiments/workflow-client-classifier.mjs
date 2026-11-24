const WINDOW = 60_000_000_000n;
const min = (a, b) => a < b ? a : b;
const max = (a, b) => a > b ? a : b;
const ns = value => BigInt(Math.round(value * 1e6));
const integerStamp = value => typeof value === 'string' && /^\d+$/.test(value);
const bounds = (lower, upper = lower) => [lower, upper];
const before = (time, boundary) => time[1] < boundary[0];
const atOrAfter = (time, boundary) => time[0] >= boundary[1];
const inWindow = (time, start, end) => atOrAfter(time, start) && before(time, end);
const outside = (time, start, end) => before(time, start) || atOrAfter(time, end);
const elapsed = (start, end) => bounds(end[0] - start[1], end[1] - start[0]);
const success = row => row.outcome === 'ok' && row.status === 200;
const blank = value => value == null || value === '';
const number = value => typeof value === 'number' ? value
  : typeof value === 'string' && value.trim() ? Number(value) : NaN;

function event(stamp) {
  if (stamp == null) return null;
  if (typeof stamp.id !== 'string' || !stamp.id || !integerStamp(stamp.host_monotonic_ns)) {
    throw new TypeError('Expected an event ID and decimal host_monotonic_ns');
  }
  return { id: stamp.id, time: bounds(BigInt(stamp.host_monotonic_ns)) };
}

function driverClock(clock) {
  const keys = ['start_before_ns', 'start_after_ns', 'end_before_ns', 'end_after_ns', 'elapsed_ns'];
  if (clock?.version !== 1 || clock.source !== 'process.hrtime.bigint' ||
      !keys.every(key => integerStamp(clock[key]))) return null;
  const [a, b, c, d, duration] = keys.map(key => BigInt(clock[key]));
  const start = bounds(max(a, c - duration - 1n), min(b, d - duration + 1n));
  if (a > b || b > c || c > d || duration <= 0n || start[0] > start[1]) return null;
  return { start, end: bounds(c, d), duration };
}

function assessConfiguration(run, expectedTargetUrl) {
  const expected = {
    rate: 5, duration_seconds: 120, warmup_seconds: 5,
    timeout_ms: 3000, max_concurrency: 50, max_lateness_ms: 200
  };
  const mismatches = Object.entries(expected).flatMap(([field, value]) =>
    run?.options?.[field] === value ? [] : [{ field, expected: value, actual: run?.options?.[field] ?? null }]);
  const target = run?.target_url;
  const url = typeof target === 'string' ? URL.parse(target) : null;
  const expectedUrl = typeof expectedTargetUrl === 'string' ? URL.parse(expectedTargetUrl) : null;
  if (expectedTargetUrl !== undefined &&
      (!expectedUrl || !['http:', 'https:'].includes(expectedUrl.protocol) || expectedUrl.pathname !== '/api/work')) {
    throw new TypeError('Expected the frozen HTTP(S) proxy URL for /api/work');
  }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/api/work' ||
      (expectedUrl && url.href !== expectedUrl.href)) {
    mismatches.push({ field: 'target_url', expected: expectedUrl?.href ?? 'HTTP(S) /api/work URL', actual: target ?? null });
  }
  return {
    status: mismatches.length ? 'noncompliant' : expectedUrl ? 'compliant' : 'unverified',
    mismatches,
    unverified: expectedUrl ? [] : ['frozen_target_url']
  };
}

function assessExecution(run) {
  const reportedStatus = run?.status ?? null;
  const issues = [];
  if (!['complete', 'incomplete', 'invalid'].includes(reportedStatus)) issues.push('missing_or_unrecognized_status');
  if (reportedStatus === 'invalid') issues.push('driver_reported_invalid');
  if (run?.output_error) issues.push('output_error');
  if (run?.fatal_error) issues.push('fatal_error');
  if (run?.invariants && Object.values(run.invariants).some(value => value !== true)) {
    issues.push('failed_driver_invariants');
  }
  if (run?.review_required === true) issues.push('driver_review_required');
  const invalid = reportedStatus === 'invalid' || Boolean(run?.output_error) ||
    (reportedStatus === 'complete' && (issues.includes('failed_driver_invariants') || Boolean(run?.fatal_error)));
  return {
    reportedStatus, issues,
    status: invalid ? 'invalid' : reportedStatus === 'incomplete' ? 'incomplete'
      : reportedStatus !== 'complete' ? 'unknown' : issues.length ? 'needs_review' : 'complete'
  };
}

function readTrace(run, requests, clock) {
  const { rate, duration_seconds: duration, warmup_seconds: warmup, max_lateness_ms: lateness } = run?.options ?? {};
  const count = rate * duration;
  if (![rate, duration].every(v => Number.isSafeInteger(v) && v > 0) ||
      !Number.isSafeInteger(count) || count > 1_000_000 ||
      !Number.isSafeInteger(warmup) || warmup < 0 || warmup >= duration ||
      !Number.isFinite(lateness) || lateness <= 0 || typeof run.run_id !== 'string' ||
      !run.run_id || !Array.isArray(requests)) return null;
  const rows = Array.from({ length: count }, (_, index) => ({
    seq: index + 1, scheduled: ns(index * (1000 / rate)), outcome: 'unknown'
  }));
  const issues = [];
  let lastDispatch = -Infinity;
  let lastSeq = 0;
  let orderValid = true;
  for (const raw of requests) {
    const seq = number(raw?.seq);
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > count) {
      issues.push({ seq: raw?.seq ?? null, reason: 'sequence_out_of_range' });
      orderValid = false;
      continue;
    }
    const row = rows[seq - 1];
    if (seq <= lastSeq) {
      issues.push({ seq, reason: 'duplicate_or_out_of_order_sequence' });
      orderValid = false;
      continue;
    }
    row.present = true;
    lastSeq = seq;
    const scheduled = number(raw.scheduled_ms);
    const dispatch = number(raw.dispatched_ms);
    const completion = number(raw.completed_ms);
    const status = blank(raw.http_status) ? null : number(raw.http_status);
    const validStatus = status === null || (Number.isInteger(status) && status >= 100 && status <= 599);
    const noCompletion = blank(raw.completed_ms) && blank(raw.latency_ms);
    const validIdentity = raw.run_id === run.run_id &&
      scheduled === (seq - 1) * (1000 / rate) &&
      String(raw.warmup) === String(scheduled < warmup * 1000) &&
      (!clock || row.scheduled <= clock.duration + 1n);
    if (validIdentity && raw.outcome === 'missed' &&
        ['late', 'concurrency'].includes(raw.miss_reason) && noCompletion &&
        blank(raw.dispatched_ms) && blank(raw.dispatch_delay_ms) &&
        status === null && blank(raw.version) && blank(raw.error_code)) {
      Object.assign(row, { outcome: 'missed', miss_reason: raw.miss_reason });
      continue;
    }
    // Allow floating-point subtraction error from performance.now() offsets.
    if (!validIdentity || !blank(raw.miss_reason) || !Number.isFinite(dispatch) ||
        dispatch < scheduled - 0.000001 || dispatch > scheduled + lateness + 0.000001 ||
        Math.abs(number(raw.dispatch_delay_ms) - (dispatch - scheduled)) > 0.000001 ||
        !Number.isFinite(number(raw.dispatch_delay_ms)) ||
        (clock && ns(dispatch) > clock.duration + 1n)) {
      issues.push({ seq, reason: 'invalid_slot_or_dispatch' });
      continue;
    }
    if (dispatch < lastDispatch) {
      issues.push({ seq, reason: 'dispatch_out_of_order' });
      orderValid = false;
    }
    lastDispatch = dispatch;
    row.dispatch = ns(dispatch);
    row.status = validStatus ? status : null;
    row.version = blank(raw.version) ? null : raw.version;
    row.error_code = blank(raw.error_code) ? null : raw.error_code;
    if ((raw.outcome === 'interrupted' || blank(raw.outcome)) && noCompletion && validStatus) {
      row.outcome = raw.outcome || 'unknown';
      issues.push({ seq, reason: row.outcome === 'interrupted' ? 'interrupted_request' : 'missing_outcome' });
      continue;
    }
    const outcome = raw.outcome;
    const http = status !== null && (outcome === 'ok' ? status >= 200 && status < 300
      : outcome === 'http_error' && (status < 200 || status >= 300));
    if (validStatus && (http || ['timeout', 'connection_error', 'driver_error'].includes(outcome)) &&
        Number.isFinite(completion) && completion >= dispatch &&
        Number.isFinite(number(raw.latency_ms)) &&
        Math.abs(number(raw.latency_ms) - (completion - dispatch)) <= 0.000001 &&
        (!clock || ns(completion) <= clock.duration + 1n)) {
      row.completion = ns(completion);
      row.outcome = outcome;
    } else {
      issues.push({ seq, reason: 'invalid_completion_or_outcome' });
    }
  }
  for (const row of rows) {
    if (!row.present) issues.push({ seq: row.seq, reason: 'missing_slot' });
  }
  return { rows, issues, orderValid, horizon: ns(duration * 1000), lateness: ns(lateness) };
}

function accounting(rows, origin, cutoff, throughCutoff) {
  const offered = [], dispatched = [], missed = [], afterCutoff = [], crossovers = [];
  const ambiguous = [], unknownSlots = [], lateCompletions = [], ambiguousCompletions = [];
  const outcomes = {};
  const failed = [], candidate = [], candidateFailed = [];
  for (const row of rows) {
    const { seq, scheduled_time: scheduled, dispatch_time: dispatch, completion_time: completion } = row;
    const member = inWindow(scheduled, origin, cutoff);
    if (dispatch && before(scheduled, origin) && inWindow(dispatch, origin, cutoff)) crossovers.push(seq);
    if ((!member && !outside(scheduled, origin, cutoff)) ||
        (member && dispatch && !before(dispatch, cutoff) && !atOrAfter(dispatch, cutoff)) ||
        (dispatch && !outside(dispatch, origin, cutoff) && !inWindow(dispatch, origin, cutoff))) {
      ambiguous.push(seq);
    }
    if (!member) continue;
    offered.push(seq);
    if (row.outcome === 'missed') missed.push({ seq, reason: row.miss_reason });
    else if (!dispatch) unknownSlots.push(seq);
    else if (atOrAfter(dispatch, cutoff)) afterCutoff.push({ seq, outcome: row.outcome });
    else if (before(dispatch, cutoff)) {
      dispatched.push(seq);
      outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
      if (completion && !success(row) && row.outcome !== 'driver_error') failed.push(seq);
      if (completion && row.version === '2.0.0') {
        candidate.push(seq);
        if (!success(row)) candidateFailed.push(seq);
      }
      if (completion && atOrAfter(completion, cutoff)) lateCompletions.push(seq);
      else if (completion && !before(completion, cutoff)) ambiguousCompletions.push(seq);
    }
  }
  const cohortComplete = throughCutoff && !unknownSlots.length && !ambiguous.length;
  const outcomesComplete = cohortComplete && !outcomes.unknown && !outcomes.interrupted && !outcomes.driver_error;
  return {
    completeness: outcomesComplete ? 'complete' : offered.length ? 'partial' : 'insufficient',
    counts: { offered: offered.length, dispatched: dispatched.length, missed: missed.length,
      afterCutoff: afterCutoff.length, crossovers: crossovers.length, ambiguous: ambiguous.length,
      unknownSlots: unknownSlots.length, failed: failed.length },
    offered, dispatched, missed, afterCutoff, crossovers, ambiguous, unknownSlots,
    lateCompletions, ambiguousCompletions, outcomes, failed, candidate, candidateFailed,
    firstCandidate: candidate.length ? rows[candidate[0] - 1].dispatch_time : null,
    failureRate: outcomesComplete && dispatched.length ? failed.length / dispatched.length : null
  };
}

function episodes(rows, cohort, cutoff, complete) {
  const items = [];
  let open = null;
  let uncertain = false;
  let lastFailure = null;
  const included = new Set(cohort.dispatched);
  const gaps = new Set([...cohort.unknownSlots, ...cohort.ambiguous]);
  for (const row of rows) {
    if (!included.has(row.seq) && !gaps.has(row.seq)) continue;
    if (gaps.has(row.seq) || !row.completion_time) {
      if (open) uncertain = true;
      continue;
    }
    if (!success(row)) {
      if (!open) open = row;
      if (!uncertain) lastFailure = row;
      continue;
    }
    if (!open) continue;
    const closed = !uncertain && before(row.completion_time, cutoff);
    const late = !uncertain && atOrAfter(row.completion_time, cutoff);
    items.push({
      firstFailure: open.seq, firstFailureDispatch: open.dispatch_time,
      lastSupportingFailure: lastFailure.seq, lastSupportingFailureDispatch: lastFailure.dispatch_time,
      nextSuccess: row.seq, censorAt: late ? cutoff : null, openAtCutoff: closed ? false : late ? true : null,
      status: closed ? 'closed' : late ? 'right_censored' : 'uncertain',
      durationNs: closed ? bounds(row.dispatch - open.dispatch) : null,
      lowerBoundNs: closed ? null : lastFailure.dispatch - open.dispatch,
      resolutionCompletion: row.completion_time
    });
    open = null;
    uncertain = false;
  }
  if (open) items.push({
    firstFailure: open.seq, firstFailureDispatch: open.dispatch_time,
    lastSupportingFailure: lastFailure.seq, lastSupportingFailureDispatch: lastFailure.dispatch_time,
    nextSuccess: null, status: complete ? 'right_censored' : 'open',
    censorAt: complete ? cutoff : null, openAtCutoff: complete ? true : null,
    durationNs: null,
    lowerBoundNs: lastFailure.dispatch - open.dispatch
  });
  const durations = items.flatMap(item => item.durationNs ? [item.durationNs[0]] : []);
  const observed = rows.some(row => included.has(row.seq) && row.completion_time);
  return {
    completeness: !observed ? 'insufficient'
      : complete && !items.some(item => item.status === 'uncertain') ? 'complete' : 'partial',
    items, count: items.length,
    completedTotalNs: observed && (complete || items.length) ? durations.reduce((sum, value) => sum + value, 0n) : null,
    longestCompletedNs: observed && (complete || items.length) ? durations.reduce(max, 0n) : null
  };
}

function milestone(rows, clock, lateness, { action, origin, cutoff, intervention, coverage, lateCoverage, version }) {
  const alternatives = [];
  let possiblePrimary = false;
  let possibleLate = false;
  let primary = null;
  let late = null;
  let firstSuccess = null;
  let earliestUncertain = null;
  const actionTime = action?.time;
  const barrier = intervention?.time;
  const mapped = offset => bounds(clock.start[0] + offset, clock.start[1] + offset);
  const tail = [];

  if (actionTime) {
    for (const row of rows) {
      const { scheduled_time: scheduled, dispatch_time: dispatch, completion_time: completion } = row;
      if (row.outcome === 'missed') {
        if (atOrAfter(scheduled, actionTime)) tail.length = 0;
        else if (!before(scheduled, actionTime)) {
          for (const entry of tail) entry.definite = false;
        }
        continue;
      }
      const dispatchRange = dispatch ?? bounds(scheduled[0], mapped(row.scheduled + lateness)[1]);
      if (before(dispatchRange, actionTime)) continue;
      const unresolved = !completion || row.outcome === 'driver_error';
      if (!unresolved && (!success(row) || row.version !== version)) {
        tail.length = 0;
        continue;
      }
      if (!unresolved && atOrAfter(dispatchRange, actionTime) && before(completion, cutoff) &&
          (!barrier || before(completion, barrier)) &&
          (!firstSuccess || completion[0] < firstSuccess.completion[0])) {
        firstSuccess = { requestId: row.seq, completion };
      }
      tail.push({
        row,
        earliest: completion?.[0] ?? max(dispatchRange[0], actionTime[0]),
        definite: Boolean(!unresolved && atOrAfter(dispatchRange, actionTime))
      });
      if (tail.length < 3) continue;
      const triple = tail.map(entry => entry.row);
      const earliest = tail.map(entry => entry.earliest).reduce(max);
      const certification = tail.every(entry => entry.definite)
        ? mapped(triple.map(item => item.completion).reduce(max)) : null;
      tail.shift();

      if (barrier && earliest >= barrier[1]) continue;
      const eligible = certification && (!barrier || before(certification, barrier));
      if (certification && before(certification, origin)) continue;
      const inPrimary = eligible && inWindow(certification, origin, cutoff);
      const inLate = eligible && atOrAfter(certification, cutoff);
      if (!inPrimary && earliest < cutoff[1]) {
        possiblePrimary = true;
        if (!earliestUncertain || earliest < earliestUncertain.time) {
          earliestUncertain = { time: earliest, seq: triple[0].seq };
        }
      }
      if (!inLate && (!certification || !before(certification, cutoff))) possibleLate = true;
      if (!certification) continue;
      const alternative = { requestIds: triple.map(item => item.seq), certification,
        cutoffMembership: inPrimary ? 'primary' : inLate ? 'late' : 'uncertain',
        attribution: eligible ? 'workflow' : 'intervention_boundary_uncertain' };
      alternatives.push(alternative);
      // Iteration is lexicographic in seq, so a tie keeps the earlier triple.
      if (inPrimary && (!primary || certification[0] < primary.certification[0])) primary = alternative;
      if (inLate && (!late || certification[0] < late.certification[0])) late = alternative;
    }
  }
  const describe = selected => selected && {
    ...selected, sinceOriginNs: elapsed(origin, selected.certification),
    sinceActionNs: elapsed(actionTime, selected.certification)
  };
  const primaryStatus = primary ? 'observed'
    : coverage && !possiblePrimary ? 'not_observed' : 'insufficient_evidence';
  const lateStatus = primary ? 'not_applicable'
    : late && (primaryStatus === 'not_observed' || version === '1.0.0') ? 'observed'
    : primaryStatus === 'not_observed' && lateCoverage && !possibleLate ? 'late_recovery_not_observed_during_available_followup'
    : 'late_followup_unavailable_or_unknown';
  return {
    primary: { status: primaryStatus, milestone: describe(primary),
      completeness: primaryStatus === 'insufficient_evidence' ? 'insufficient'
        : primary && earliestUncertain && (earliestUncertain.time < primary.certification[1] ||
          (earliestUncertain.time === primary.certification[1] &&
           earliestUncertain.seq < primary.requestIds[0])) ? 'partial' : 'complete' },
    late: { status: lateStatus, milestone: lateStatus === 'observed' ? describe(late) : null,
      primaryAbsenceEstablished: primaryStatus === 'not_observed' },
    alternatives, possiblePrimary, possibleLate, firstSuccess,
    actionId: action?.id ?? null, interventionId: intervention?.id ?? null,
    actionCutoffMembership: !action ? null : before(action.time, cutoff) ? 'primary'
      : atOrAfter(action.time, cutoff) ? 'post_cutoff_action' : 'uncertain'
  };
}

const recoveryStatuses = {
  observed: 'recovered_in_window',
  not_observed: 'no_in_window_recovery',
  insufficient_evidence: 'insufficient_evidence'
};

const notApplicable = () => ({
  primary: { status: 'not_applicable', milestone: null },
  late: { status: 'not_applicable', milestone: null }
});

/**
 * Classify parsed Driver V1 run.json and requests.csv rows (original column names).
 * Events are { id, host_monotonic_ns } on the Driver V1 host.
 * origin is deployment invocation for S1/S2 and fault acknowledgment for S3.
 * deployment is separately required for the S3 pre-fault candidate metric.
 * restore identifies a normal workflow action only. Explicit null attests no action.
 * intervention is the first cleanup/manual/emergency action. Explicit null attests none.
 * recoveryApplicable describes the reached workflow stage; exposureConfirmed attests
 * actual exposure for a negative conclusion. Omission leaves that evidence unknown.
 * prevention supplies rejection and stable-continuity events for an S2 H arm.
 * expectedTargetUrl is the optional independently frozen proxy URL for compliance checks.
 * externalVerification is independently sourced and never used for client metrics.
 * Times in results are decimal ns strings, with pairs denoting inclusive bounds.
 */
export function classifyWorkflowClient({
  scenario, arm, run, requests, origin: originInput, deployment: deploymentInput,
  faultWriteStarted, restore, intervention: interventionInput, prevention,
  recoveryApplicable, exposureConfirmed, externalVerification, expectedTargetUrl
} = {}) {
  if (!['S1', 'S2', 'S3'].includes(scenario) || !['H', 'C'].includes(arm)) {
    throw new TypeError('Expected an H/C arm and S1, S2 or S3 scenario');
  }
  const origin = event(originInput);
  const deployment = scenario === 'S3' ? event(deploymentInput) : origin;
  const action = event(restore);
  const intervention = event(interventionInput);
  const external = event(externalVerification);
  const clock = driverClock(run?.clock_alignment);
  const trace = readTrace(run, requests, clock);
  const rejected = event(prevention?.rejected);
  const continuity = event(prevention?.stableContinuity);

  const configuration = assessConfiguration(run, expectedTargetUrl);
  const execution = assessExecution(run);
  const result = {
    configuration, execution,
    requestIntegrity: {
      status: !trace ? 'unavailable' : !trace.orderValid ? 'invalid'
        : trace.issues.length ? 'partial' : 'complete'
    },
    scenario, arm, runId: run?.run_id ?? null,
    events: { origin, deployment, restore: action, intervention, rejected, continuity },
    externalVerification: { completeness: external ? 'complete' : 'insufficient', event: external },
    trace: { clock, issues: trace?.issues ?? [], orderValid: trace?.orderValid ?? false }
  };
  const cannotClassify = reason => ({ completeness: 'insufficient', reason });
  const unavailableMilestone = () => ({
    primary: { status: 'insufficient_evidence', milestone: null },
    late: { status: 'late_followup_unavailable_or_unknown', milestone: null }
  });
  result.accounting = cannotClassify('missing_primary_origin');
  result.episodes = cannotClassify('missing_primary_origin');
  result.candidate = unavailableMilestone();
  result.recovery = scenario === 'S1' || recoveryApplicable === false ? notApplicable() : unavailableMilestone();
  result.prevention = { status: scenario === 'S2' && arm === 'H' ? 'insufficient_evidence' : 'not_applicable' };

  if (trace && clock && trace.orderValid) {
    const map = offset => offset === undefined ? null : bounds(clock.start[0] + offset, clock.start[1] + offset);
    const rows = trace.rows.map(row => ({
      seq: row.seq, scheduled: row.scheduled, completion: row.completion, scheduled_time: map(row.scheduled), dispatch_time: map(row.dispatch),
      completion_time: map(row.completion), dispatch: row.dispatch,
      outcome: row.outcome, status: row.status ?? null, version: row.version ?? null,
      error_code: row.error_code ?? null, miss_reason: row.miss_reason ?? null
    }));
    const horizon = map(trace.horizon);
    const observedThrough = bounds(min(clock.end[0], horizon[0]), min(clock.end[1], horizon[1]));
    const covers = (start, end) => atOrAfter(start, clock.start) && atOrAfter(observedThrough, end);
    const intact = (start, end) => !rows.some(row => {
      const possibleDispatch = row.dispatch_time ??
        bounds(row.scheduled_time[0], row.scheduled_time[1] + trace.lateness);
      return !outside(possibleDispatch, start, end) &&
        ['interrupted', 'unknown', 'driver_error'].includes(row.outcome);
    });
    const hasResponse = (start, end) => rows.some(row => row.completion_time &&
      inWindow(row.dispatch_time, start, end) && row.outcome !== 'driver_error');
    const unconfounded = end => interventionInput !== undefined &&
      (!intervention || atOrAfter(intervention.time, end));
    result.trace = { ...result.trace, scheduleHorizon: horizon, drainEnd: clock.end, rows };

    if (origin) {
      const cutoff = bounds(origin.time[0] + WINDOW);
      result.window = { originId: origin.id, origin: origin.time, cutoff, observedThrough };
      const lateEnd = intervention
        ? bounds(min(clock.end[0], intervention.time[0]), min(clock.end[1], intervention.time[1])) : clock.end;
      result.followup = {
        start: cutoff, end: lateEnd,
        durationNs: elapsed(cutoff, lateEnd).map(value => max(0n, value)),
        observedThrough: lateEnd
      };
      const covered = covers(origin.time, cutoff);
      const cohort = accounting(rows, origin.time, cutoff, covered);
      result.accounting = cohort;
      result.episodes = episodes(rows, cohort, cutoff, cohort.completeness === 'complete');
      if (scenario === 'S2' && arm === 'H' && rejected && continuity &&
          inWindow(rejected.time, origin.time, cutoff) && atOrAfter(continuity.time, cutoff) &&
          cohort.completeness === 'complete' && cohort.dispatched.length &&
          !cohort.failed.length && !cohort.candidate.length && unconfounded(cutoff) &&
          cohort.dispatched.every(seq => success(rows[seq - 1]) && rows[seq - 1].version === '1.0.0') &&
          !cohort.crossovers.some(seq => !success(rows[seq - 1]) || rows[seq - 1].version !== '1.0.0')) {
        result.prevention = { status: 'successful_prevention', eventIds: [rejected.id, continuity.id] };
        result.recovery = notApplicable();
      }

      if (scenario !== 'S1' && result.recovery.primary.status !== 'not_applicable' &&
          (recoveryApplicable === true || (action && exposureConfirmed === true))) {
        // Draft v1.2 does not specify how many sampling gaps can support a negative.
        const negativeEvidenceGaps = [];
        if (!covered || !intact(origin.time, cutoff) || cohort.unknownSlots.length) {
          negativeEvidenceGaps.push('incomplete_primary_measurement');
        }
        if (!hasResponse(origin.time, cutoff) || cohort.missed.length || cohort.afterCutoff.length ||
            cohort.ambiguous.length) {
          negativeEvidenceGaps.push('primary_sampling_coverage_not_established');
        }
        if (!unconfounded(cutoff) || restore === undefined || exposureConfirmed !== true) {
          negativeEvidenceGaps.push('primary_attribution_not_established');
        }
        if (['invalid', 'unknown'].includes(execution.status)) negativeEvidenceGaps.push('driver_execution_unverified');
        if (configuration.status === 'noncompliant') negativeEvidenceGaps.push('workload_configuration_noncompliant');
        const recovery = milestone(rows, clock, trace.lateness, {
          action: interventionInput === undefined ? null : action, origin: origin.time, cutoff,
          intervention, version: '1.0.0',
          coverage: negativeEvidenceGaps.length === 0,
          lateCoverage: before(cutoff, lateEnd) && execution.status === 'complete' &&
            (!intervention || atOrAfter(intervention.time, clock.end)) && intact(cutoff, lateEnd)
        });
        if (recovery.possiblePrimary) negativeEvidenceGaps.push('possible_uncertified_primary_streak');
        recovery.primary.negativeEvidenceGaps = negativeEvidenceGaps;
        recovery.primary.status = recoveryStatuses[recovery.primary.status];
        if (recovery.late.status === 'observed') recovery.late.status = 'late_recovery_observed';
        result.recovery = recovery;
      }
    }

    const writeStart = event(faultWriteStarted);
    const candidateEnd = scenario === 'S3' ? writeStart ?? origin : null;
    result.events.faultWriteStarted = writeStart;
    if (deployment && (scenario !== 'S3' || candidateEnd || recoveryApplicable === false)) {
      const cutoff = bounds(deployment.time[0] + WINDOW);
      const end = candidateEnd ? bounds(min(cutoff[0], candidateEnd.time[0])) : cutoff;
      result.candidate = milestone(rows, clock, trace.lateness, {
        action: interventionInput === undefined ? null : deployment,
        origin: deployment.time, cutoff: end, intervention,
        coverage: covers(deployment.time, end) && intact(deployment.time, end) &&
          hasResponse(deployment.time, end) && unconfounded(end),
        lateCoverage: false, version: '2.0.0'
      });
      // A post-fault candidate response cannot establish pre-fault service.
      if (scenario === 'S3') result.candidate.late = notApplicable().late;
      result.candidate.cutoff = end;
      result.candidate.cutoffEventId = candidateEnd?.id ?? deployment.id;
    }
  } else {
    const reason = !clock ? 'invalid_or_missing_clock' : !trace ? 'invalid_or_missing_trace' : 'invalid_sequence';
    result.accounting = cannotClassify(reason);
    result.episodes = cannotClassify(reason);
  }
  return JSON.parse(JSON.stringify(result, (_, value) => typeof value === 'bigint' ? String(value) : value));
}
