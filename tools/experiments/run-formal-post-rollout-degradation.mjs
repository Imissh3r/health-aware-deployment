import { runFormalFaultScenario } from './run-formal-faulty-candidate.mjs';

const SECOND = 1_000_000_000n;
const SETTLING = 5n * SECOND;
const FAULT_COMMAND_BUDGET = 10n * SECOND;
const hostNs = event => BigInt(event.host_monotonic_ns);
const healthyCandidate = sample => sample?.http_status === 200 && sample.version === '2.0.0';

/**
 * Runs a single create-once S3 arm with the S1/S2 frozen environment settings.
 * Honor nextArmAllowed before starting another arm. Offline adapters are optional.
 */
export function runFormalPostRolloutDegradation(input, adapters) {
  return runFormalFaultScenario(input, adapters, { prepare, faultBudget: FAULT_COMMAND_BUDGET, detection });
}

async function prepare({
  ops, record, horizon, primary, driverLive, waitFor, verified, observerFinished, samples,
  deployment, owns, monitorLive, writeFault
}) {
  if (!deployment) return 'deployment_evidence_missing';
  if (!['PROMOTED', 'SWITCHED'].includes(deployment.status)) return 'deployment_failure';
  const latestWrite = horizon - primary - FAULT_COMMAND_BUDGET;
  const latestVerification = latestWrite - SETTLING;
  const ready = await waitFor(latestVerification, Promise.race([verified, observerFinished]));
  if (!driverLive()) return 'measurement_coverage_failure';
  if (!ready) return 'workflow_time_budget_exceeded';
  if (ready.event !== 'candidate_externally_verified') return 'observer_coverage_failure';

  const settleUntil = hostNs(ready) + SETTLING;
  const guard = (phase, at = ops.now(), shortage = 'measurement_coverage_failure') => {
    const running = driverLive();
    const earliestWrite = at > settleUntil ? at : settleUntil;
    const passed = running && earliestWrite <= latestWrite;
    record('post_rollout_horizon_checked', {
      phase, passed, driver_running: running, verification_event_id: ready.id,
      settling_until_ns: String(settleUntil), schedule_end_lower_ns: String(horizon),
      remaining_schedule_ns: String(horizon - at), fault_ack_budget_ns: String(FAULT_COMMAND_BUDGET),
      primary_window_ns: String(primary), latest_fault_write_ns: String(latestWrite),
      reason: passed ? null : running ? shortage : 'measurement_coverage_failure'
    }, at);
    return passed;
  };
  if (!guard('after_candidate_verification', ops.now(), 'workflow_time_budget_exceeded')) return driverLive() ? 'workflow_time_budget_exceeded' : 'measurement_coverage_failure';

  await waitFor(settleUntil);
  if (!driverLive()) return 'measurement_coverage_failure';
  if (!owns()) return 'unsafe_routing';
  if (!monitorLive()) return 'monitor_unavailable';
  let flag;
  try { flag = await ops.faultState(); }
  catch (error) {
    record('pre_fault_flag_checked', { state: null, reason: error.message });
    return 'unsafe_fault_state';
  }
  record('pre_fault_flag_checked', { state: flag });
  if (flag?.present !== false) return 'unsafe_fault_state';
  const started = ops.now();
  let surface;
  try { surface = await ops.observe(); }
  catch (error) {
    record('pre_fault_candidate_rechecked', { reason: error.message });
    return 'observer_coverage_failure';
  }
  record('pre_fault_candidate_rechecked', { started_monotonic_ns: String(started), observation: surface });
  if (!owns()) return 'unsafe_routing';
  if (!healthyCandidate(surface) || samples.some(sample =>
    hostNs(sample) > hostNs(ready) && !healthyCandidate(sample.observation))) return 'candidate_service_regressed';

  if (!guard('before_fault_command')) return 'measurement_coverage_failure';
  let refusal;
  const adapterRefusal = await writeFault(() => {
    if (!owns()) refusal = 'unsafe_routing';
    else if (!monitorLive()) refusal = 'monitor_unavailable';
    else if (!guard('immediately_before_fault_write')) {
      refusal = 'measurement_coverage_failure';
    }
    return refusal;
  });
  return refusal ?? adapterRefusal;
}

function detection(action, start, acknowledgment, cutoff, measuredAbsence) {
  if (!acknowledgment) return { status: 'not_applicable' };
  if (!action) return { status: measuredAbsence ? 'not_observed' : 'insufficient_evidence' };
  const at = hostNs(action);
  const startOffset = at - hostNs(start);
  const ackOffset = at - hostNs(acknowledgment);
  const evidence = {
    event_id: action.id, originating_event_id: acknowledgment.id, fault_write_start_id: start.id,
    from_write_start_ns: String(startOffset), from_acknowledgment_ns: String(ackOffset)
  };
  if (startOffset < 0n) return { status: 'attribution_review', ...evidence };
  if (ackOffset < 0n) return { status: 'origin_uncertain', ...evidence,
    onset_relative_bounds_ns: [String(ackOffset), String(startOffset)] };
  if (at >= cutoff) return { status: 'post_cutoff_action', ...evidence };
  return { status: 'observed', latency_ns: String(ackOffset), ...evidence };
}
