import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { auditWorkflowCollection, inside } from './workflow-evidence-audit.mjs';

const version = '1.0.0';
const metrics = ['failure_detection_time', 'recovery_time', 'observed_downtime',
  'failed_requests', 'recovery_success', 'deployment_overhead'];
const limitations = [
  'Descriptive paired comparison on one host. No inference about general superiority or component-level causation.',
  'The conventional treatment includes a modeled 10-second operator delay. Fault evidence concerns candidate HTTP 500.',
  'Client and observer sample at nominal 5 Hz and 1 Hz. Sampled disruption and failed requests are related.',
  'Stable response identity supports recovery under the tested scenario. Successful-response durations are conditional on observed milestones.',
  'WP4 does not bind the full artifact set, executable bytes or per-arm observed environment to independent digests.',
  'Frozen V1 and historical pilot evidence are outside this analysis.'
];
const observed = (value, unit, extra = {}) => ({ status: 'observed', value, unit, ...extra });
const state = (status, reason, extra = {}) => ({ status, reason, ...extra });
const na = reason => state('not_applicable', reason);
const insufficient = reason => state('insufficient_evidence', reason);
const stamp = event => BigInt(event.host_monotonic_ns);
const exact = bounds => Array.isArray(bounds) && bounds.length === 2 && bounds[0] === bounds[1] ? bounds[0] : null;
const delta = (a, b) => a && b ? String(stamp(b) - stamp(a)) : null;
const bad = record => ['missing', 'inconsistent', 'corrupted'].includes(record.status);
const countBy = values => Object.fromEntries([...new Set(values)].sort().map(value =>
  [value, values.filter(item => item === value).length]));

function timing(primary) {
  if (!primary) return insufficient('no_classifier_metric');
  if (primary.status === 'not_applicable') return na('classifier_not_applicable');
  if (['not_observed', 'no_in_window_recovery'].includes(primary.status)) {
    return state('censored', primary.status, { classifierStatus: primary.status });
  }
  const milestone = primary.milestone;
  if (!milestone) return insufficient('no_certified_primary_milestone');
  const evidence = { milestone };
  const value = exact(milestone.sinceOriginNs);
  return primary.completeness === 'complete' && value !== null
    ? observed(value, 'ns', evidence) : state('uncertain',
      primary.completeness === 'complete' ? 'clock_interval' : 'earliest_certification_uncertainty', evidence);
}

function detection(trial, evidence) {
  const { summary, result, eventIndex } = evidence;
  const { workflow, origin } = summary;
  if (trial.scenario === 'S1' || (trial.scenario === 'S2' && trial.arm === 'H')) return na('protocol_scenario_endpoint');
  if (trial.scenario === 'S3' && !origin && result.recovery.primary.status === 'not_applicable') return na('stage_not_reached');
  if (!origin) return insufficient('primary_origin_unavailable');
  const event = trial.arm === 'C' ? workflow.alert : workflow.locked_confirmation;
  const declared = workflow.detection;
  if (!event && trial.scenario === 'S2' && result.recovery.primary.status === 'not_applicable') {
    return na('no_public_fault_exposure_requiring_alert');
  }
  if (!event && trial.scenario === 'S2' && summary.observer?.primary_covered && result.accounting.candidateFailed?.length) {
    return state('censored', 'no_actionable_detection_observed');
  }
  if (!event) {
    const covered = trial.arm === 'C' ? summary.observer?.primary_covered
      : workflow.monitor_status?.outcome?.status === 'ADMISSION_CLOSED';
    return declared?.status === 'not_observed' && covered && summary.metrics?.client_coverage?.primary_covered
      ? state('censored', 'no_actionable_detection_observed') : insufficient('actionable_detection_unavailable');
  }
  const expected = trial.arm === 'C' ? 'external_alert' : 'monitor_locked_confirmation';
  if (event.event !== expected) return state('invalid', 'detection_event_type_conflict');
  const ns = delta(origin, event);
  const details = { eventId: event.id, originId: origin.id };
  if (trial.scenario === 'S3') {
    const start = summary.fault_write_started;
    if (!start || declared?.event_id !== event.id || declared.originating_event_id !== origin.id ||
        declared.fault_write_start_id !== start.id || declared.from_acknowledgment_ns !== ns ||
        declared.from_write_start_ns !== delta(start, event) || !eventIndex.has(event.id)) {
      return state('invalid', 'detection_provenance_conflict');
    }
    if (stamp(event) < stamp(start)) return state('invalid', 'attribution_precedes_write_start', details);
    if (stamp(event) < stamp(origin)) {
      const bounds = [ns, delta(start, event)];
      if (declared.status !== 'origin_uncertain' || JSON.stringify(bounds) !== JSON.stringify(declared.onset_relative_bounds_ns)) {
        return state('invalid', 'detection_origin_bounds_conflict');
      }
      return state('uncertain', 'origin_uncertain', { ...details, boundsNs: bounds });
    }
    if (stamp(event) < BigInt(origin.cutoff_ns) && (declared.status !== 'observed' || declared.latency_ns !== ns)) {
      return state('invalid', 'detection_latency_conflict');
    }
  } else if (stamp(event) < stamp(origin) ||
      (stamp(event) < BigInt(origin.cutoff_ns) &&
        (workflow.primary_deployment_to_alert?.elapsed_ns !== ns ||
          workflow.primary_deployment_to_alert?.start_event_id !== origin.id ||
          workflow.primary_deployment_to_alert?.end_event_id !== event.id))) {
    return state('invalid', 'deployment_origin_alert_conflict');
  }
  if (stamp(event) < BigInt(origin.cutoff_ns)) return observed(ns, 'ns', details);
  if (trial.scenario === 'S3' && declared?.status !== 'post_cutoff_action') {
    return state('invalid', 'detection_cutoff_conflict', details);
  }
  return state('censored', 'post_cutoff_action', details);
}

function metricsFor(trial, evidence) {
  const unavailable = (status, reason) => Object.fromEntries(metrics.map(metric => [metric, state(status, reason)]));
  if (!trial.terminal) return unavailable('missing', trial.status);
  const { summary, result, clockVerified, earlyCleanup } = evidence ?? {};
  if (!summary || !result) return unavailable(evidence?.issues.some(bad) ||
    evidence?.artifacts.some(item => ['corrupted', 'inconsistent'].includes(item.status)) ? 'invalid' : 'missing',
  'verified_metric_inputs_unavailable');
  if (summary.validity.status === 'invalid') return unavailable('invalid', 'runner_technical_invalidity');
  if (evidence.issues.some(bad) || evidence.artifacts.some(bad)) return unavailable('invalid', 'evidence_integrity_failure');
  if (!clockVerified || result.configuration.status !== 'compliant' || result.requestIntegrity.status === 'invalid') {
    return unavailable('insufficient_evidence', 'driver_clock_or_configuration_unverified');
  }
  const { scenario, arm } = trial;
  const preFaultOnly = scenario === 'S3' && !summary.origin && result.recovery.primary.status === 'not_applicable';
  const recoveryApplicable = scenario === 'S3' || (scenario === 'S2' && arm === 'C');
  const { primary } = result.recovery;
  const recoveryKnown = ['recovered_in_window', 'no_in_window_recovery'].includes(primary.status);
  const recoverySuccess = !recoveryApplicable ? na('no_primary_recovery_measure_for_scenario_arm')
    : primary.status === 'not_applicable' ? na(preFaultOnly ? 'stage_not_reached' : 'no_recovery_needed')
    : recoveryKnown && summary.metrics?.client_coverage?.primary_covered === true
      ? observed(primary.status, 'category', { milestone: primary.milestone })
      : insufficient('recovery_or_primary_coverage_unestablished');
  const { accounting, episodes } = result;
  let downtime = insufficient('client_episodes_incomplete');
  if (episodes.items?.some(episode => episode.status !== 'closed')) {
    downtime = state(episodes.items.some(episode => ['uncertain', 'open'].includes(episode.status))
      ? 'uncertain' : 'censored', 'open_or_uncertain_failure_episode', { episodes });
  } else if (episodes.completeness === 'complete' && episodes.completedTotalNs !== null) {
    downtime = observed(episodes.completedTotalNs, 'ns', { episodes });
  }
  const failures = accounting.completeness === 'complete' && accounting.counts.dispatched > 0
    ? observed(accounting.counts.failed, 'requests', { accounting })
    : insufficient('complete_dispatched_cohort_unavailable');
  let rows = {
    failure_detection_time: detection(trial, evidence),
    recovery_time: !recoveryApplicable ? na('no_primary_recovery_duration_for_scenario_arm')
      : preFaultOnly ? na('stage_not_reached')
      : recoveryKnown && recoverySuccess.status !== 'observed' ? insufficient('primary_coverage_unestablished') : timing(primary),
    observed_downtime: preFaultOnly ? na('stage_not_reached') : downtime,
    failed_requests: preFaultOnly ? na('stage_not_reached') : failures,
    recovery_success: recoverySuccess,
    deployment_overhead: scenario === 'S2' ? na('no_common_s2_deployment_endpoint') : timing(result.candidate.primary)
  };
  if (earlyCleanup) rows = Object.fromEntries(Object.entries(rows).map(([key, value]) =>
    [key, value.status === 'not_applicable' ? value : state('invalid', 'cleanup_before_primary_cutoff')]));
  rows.deployment_overhead.role = scenario === 'S3' ? 'supporting_pre_fault' : 'primary';
  return rows;
}

function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = p => {
    const index = (sorted.length - 1) * p;
    const low = Math.floor(index);
    return sorted[low] + (sorted[Math.ceil(index)] - sorted[low]) * (index - low);
  };
  const q1 = quantile(0.25);
  const q3 = quantile(0.75);
  return { n: sorted.length, min: sorted[0], q1, median: quantile(0.5), q3, max: sorted.at(-1), iqr: q3 - q1 };
}

function supporting(evidence) {
  const { summary, result, requests } = evidence ?? {};
  if (!summary) return null;
  const { workflow = {}, observer = {}, preparation = {} } = summary;
  const event = e => e ? { id: e.id, atNs: e.host_monotonic_ns, postCutoff: e.post_cutoff_action ?? e.after_primary_cutoff ?? null } : null;
  const action = workflow.restore;
  const actionable = summary.arm === 'H' ? workflow.locked_confirmation : workflow.alert;
  const external = observer.stable_verification ?? observer.verification;
  const latency = [];
  if (result?.accounting.dispatched && requests) {
    for (const seq of result.accounting.dispatched) {
      const row = requests[seq - 1];
      if (row?.outcome === 'ok' && row.http_status === '200' && row.latency_ms !== '' &&
          Number.isFinite(Number(row.latency_ms))) latency.push(Number(row.latency_ms));
    }
  }
  return {
    deployment: workflow.deployment ?? null, stage: summary.stage ?? null, stageReason: summary.fault_stage_reason ?? null,
    prevention: result?.prevention ?? null, candidateResponses: result?.accounting.candidate ?? null,
    candidateFailedResponses: result?.accounting.candidateFailed ?? null,
    firstCandidateDispatch: result?.accounting.firstCandidate ?? null, accounting: result?.accounting ?? null,
    candidateFirstSuccess: result?.candidate.firstSuccess ?? null, candidateLate: result?.candidate.late ?? null,
    clientRecovery: result?.recovery.primary ?? null, lateRecovery: result?.recovery.late ?? null,
    recoveryAlternatives: result?.recovery.alternatives ?? null, followup: result?.followup ?? null,
    observerCovered: observer.primary_covered ?? null, cleanup: summary.cleanup?.status ?? null,
    reset: summary.reset?.status ?? null, earlyCleanup: evidence.earlyCleanup,
    observerVerification: event(external), preFaultVerification: event(summary.candidate_verified),
    origin: event(summary.origin), faultWriteStart: event(summary.fault_write_started),
    detection: event(actionable), thirdFailure: event(workflow.third_failure), restore: event(action),
    lockDetection: workflow.detection ?? null, detectionToActionNs: delta(actionable, action),
    originToExternalNs: delta(summary.origin, external),
    operatorDelay: workflow.alert_to_restore ?? null, activationToAlert: workflow.fault_ack_to_alert ?? null,
    preventionDecision: workflow.promotion_rejection_latency ?? null,
    preparationIntervals: Object.fromEntries(['acknowledgment_to_confirmation', 'confirmation_to_deployment',
      'acknowledgment_to_deployment', 'deployment_to_acknowledgment'].map(key => [key, preparation[key] ?? null])),
    toleranceBreached: preparation.tolerance_breached ?? null,
    routeRegressions: workflow.route_regressions ?? null, clientRouteRegressions: workflow.client_route_regression_request_ids ?? null,
    routeTiming: workflow.route_timing_bounds ? Object.fromEntries(['candidate_installation', 'stable_restoration'].map(key =>
      [key, { earliest: event(workflow.route_timing_bounds[key]?.earliest_event),
        latest: event(workflow.route_timing_bounds[key]?.latest_event) }])) : null,
    restoreOutcome: workflow.restore_outcome?.outcome?.status ?? null,
    successfulResponseLatencyMs: summarize(latency)
  };
}

const scopedIssues = new Set(['external_coverage_incomplete', 'observer_coverage_incomplete',
  'client_coverage_incomplete', 'driver_execution_not_complete', 'monitor_timing_missing',
  'post_fault_coverage_not_established']);

function trialUsable(trial, evidence, reviewed) {
  const validity = trial.terminal?.outcome.validity;
  return trial.status === 'completed' && evidence?.result && evidence.clockVerified &&
    evidence.result.configuration.status === 'compliant' && evidence.result.requestIntegrity.status !== 'invalid' &&
    !evidence.issues.some(bad) && !evidence.artifacts.some(bad) && !evidence.earlyCleanup &&
    (validity?.status === 'valid' || (validity?.status === 'needs_review' && reviewed &&
      validity.issues.length > 0 && validity.issues.every(issue => scopedIssues.has(issue))));
}

function numericBounds(metric) {
  if (metric.status === 'observed' && metric.unit === 'ns') return [Number(metric.value), Number(metric.value)];
  if (metric.status === 'uncertain' && metric.reason === 'clock_interval' && metric.milestone) return metric.milestone.sinceOriginNs.map(Number);
  return null;
}

function aggregate(pairs, scenario) {
  const selected = pairs.filter(pair => pair.scenario === scenario);
  const accepted = selected.filter(pair => pair.acceptedAttemptId);
  const acceptedArms = accepted.flatMap(pair => pair.attempts.at(-1).arms);
  const allArms = selected.flatMap(pair => pair.attempts.flatMap(attempt => attempt.arms));
  const eligible = acceptedArms.filter(arm => arm.supporting?.stage === 'FAULT_ACKNOWLEDGED' &&
    arm.metrics.recovery_success.status === 'observed');
  const measure = Object.fromEntries(metrics.map(key => {
    const examples = accepted.map(pair => {
      const arms = pair.attempts.at(-1).arms;
      const H = arms.find(arm => arm.arm === 'H');
      const C = arms.find(arm => arm.arm === 'C');
      const h = H.metrics[key];
      const c = C.metrics[key];
      const comparable = h.status === 'observed' && c.status === 'observed' && h.unit === c.unit;
      const hb = numericBounds(h);
      const cb = numericBounds(c);
      return { pairId: pair.pairId, attemptId: pair.acceptedAttemptId, H: { trialId: H.trialId, ...h },
        C: { trialId: C.trialId, ...c }, difference: comparable && h.unit !== 'category'
          ? Number(c.value) - Number(h.value) : null,
        differenceBoundsNs: hb && cb && !comparable ? [cb[0] - hb[1], cb[1] - hb[0]] : null,
        category: comparable && h.unit === 'category' ? h.value + ' / ' + c.value : null };
    });
    const paired = examples.filter(pair => pair.difference !== null);
    const categories = examples.flatMap(pair => pair.category ? [pair.category] : []);
    return [key, { acceptedPairs: accepted.length, numericPairs: paired.length, categoricalPairs: categories.length,
      boundedPairs: examples.filter(pair => pair.differenceBoundsNs).length,
      pairedCategoriesHThenC: countBy(categories),
      armStatuses: Object.fromEntries(['H', 'C'].map(arm => [arm, countBy(examples.map(item => item[arm].status))])),
      armCategories: Object.fromEntries(['H', 'C'].map(arm => [arm,
        countBy(examples.flatMap(item => item[arm].unit === 'category' ? [item[arm].value] : []))])),
      observedArmDistributions: Object.fromEntries(['H', 'C'].map(arm => [arm,
        summarize(examples.filter(item => item[arm].status === 'observed' && item[arm].unit !== 'category')
          .map(item => Number(item[arm].value)))])),
      H: summarize(paired.map(pair => Number(pair.H.value))), C: summarize(paired.map(pair => Number(pair.C.value))),
      differencesCMinusH: summarize(paired.map(pair => pair.difference)), examples }];
  }));
  return {
    scenario, plannedPairs: selected.length, acceptedPairs: accepted.length,
    attemptedArms: allArms.filter(arm => arm.started).length, armStates: countBy(allArms.map(arm => arm.status)),
    validity: countBy(allArms.map(arm => arm.validity?.status ?? 'unadjudicated')),
    replacements: selected.reduce((total, pair) => total + pair.attempts.length - 1, 0),
    selectionStatuses: countBy(selected.map(pair => pair.selectionReason)),
    assignedArmOutcomes: Object.fromEntries(['H', 'C'].map(label => [label, countBy(selected.map(pair => {
      const attempt = pair.attempts.at(-1);
      const arm = attempt.arms.find(entry => entry.arm === label);
      return arm.supporting?.deployment ?? arm.status;
    }))])),
    ...(scenario === 'S3' && { recoveryFlow: {
      allAssigned: selected.length * 2,
      latestAttemptStages: countBy(selected.flatMap(pair => pair.attempts.at(-1).arms.map(arm =>
        arm.supporting?.stageReason ?? arm.supporting?.stage ?? arm.status))),
      acceptedArmEligibility: countBy(acceptedArms.map(arm => eligible.includes(arm) ? 'eligible'
        : arm.supporting?.stageReason ?? arm.metrics.recovery_success.status)),
      eligible: eligible.length, recoveredInWindow: eligible.filter(arm =>
        arm.metrics.recovery_success.value === 'recovered_in_window').length,
      lateObserved: eligible.filter(arm => arm.supporting?.lateRecovery?.status === 'late_recovery_observed').length,
      lateStatuses: countBy(eligible.map(arm => arm.supporting?.lateRecovery?.status ?? 'unavailable')),
      byArm: Object.fromEntries(['H', 'C'].map(label => {
        const arms = eligible.filter(arm => arm.arm === label);
        return [label, { assigned: selected.length, eligible: arms.length,
          primary: countBy(arms.map(arm => arm.metrics.recovery_success.value)),
          late: countBy(arms.map(arm => arm.supporting?.lateRecovery?.status ?? 'unavailable')) }];
      }))
    } }),
    measures: measure
  };
}

export function analyzeWorkflowCollection(directory) {
  const input = auditWorkflowCollection(directory);
  const { manifest, mode } = input.wrapper ?? {};
  const blocked = !input.ledger || input.issues.some(bad) || input.artifacts.some(bad);
  const pairs = input.pairs.map(pair => {
    const latest = pair.attempts.at(-1);
    const reviewed = latest.disposition === 'retained_for_review';
    const usable = latest.arms.every(arm => trialUsable(arm, input.trialEvidence.get(arm.trialId), reviewed));
    const acceptedAttemptId = !blocked && usable ? latest.attemptId : null;
    const selectionReason = blocked ? 'collection_integrity_blocked'
      : acceptedAttemptId ? reviewed ? 'retained_with_metric_scoped_review' : 'current_valid_round'
        : latest.arms.some(arm => arm.status !== 'completed') ? 'incomplete_round'
          : latest.arms.some(arm => arm.terminal.outcome.validity.status === 'invalid') ? 'technical_invalidity'
            : 'evidence_or_validity_unresolved';
    return { ...pair, acceptedAttemptId, selectionReason, attempts: pair.attempts.map(attempt => ({
      ...attempt,
      arms: attempt.arms.map(({ start, terminal, ...trial }) => {
        const evidence = input.trialEvidence.get(trial.trialId);
        const trusted = evidence?.summary && evidence.result && evidence.clockVerified &&
          !evidence.earlyCleanup && !evidence.issues.some(bad) && !evidence.artifacts.some(bad);
        return { ...trial, started: Boolean(start), validity: terminal?.outcome.validity
          ? { status: terminal.outcome.validity.status, issues: terminal.outcome.validity.issues.filter(issue =>
            typeof issue === 'string' && /^[a-z_]+$/.test(issue)) } : null,
        evidenceRef: start ? join(mode === 'fixture' ? 'fixture-evidence' : 'trial-evidence', trial.trialId) : null,
        accepted: attempt.attemptId === acceptedAttemptId,
        metrics: metricsFor({ ...trial, terminal }, evidence),
        recordedOutcome: typeof terminal?.outcome.workflow?.deployment === 'string' &&
          /^[A-Z_]+$/.test(terminal.outcome.workflow.deployment) ? terminal.outcome.workflow.deployment : null,
        supporting: trusted ? supporting(evidence) : null };
      })
    })) };
  });
  const audit = {
    status: blocked ? 'blocked' : [...input.trialEvidence.values()].some(evidence =>
      evidence.issues.some(bad) || evidence.artifacts.some(bad)) ? 'trial_integrity_issues' : 'provenance_unverifiable',
    collectionArtifacts: input.artifacts, issues: input.issues,
    trials: [...input.trialEvidence].map(([trialId, evidence]) =>
      ({ trialId, artifacts: evidence.artifacts, issues: evidence.issues, clockVerified: evidence.clockVerified ?? false })),
    collectionState: input.ledger?.status ?? 'unavailable',
    operatorAnnotations: (input.ledger?.events ?? []).filter(event =>
      ['pair_decision', 'reconcile', 'preflight_blocked', 'interrupted'].includes(event.type)).map(event =>
      ({ ledgerSequence: event.sequence, type: event.type, trialId: event.trialId ?? event.trial?.trialId ?? null,
        attemptId: event.attemptId ?? null, decision: event.decision ?? null,
        authorizationRecorded: Boolean(event.authorizedBy && event.evidenceRef && event.reason),
        resetAttested: event.resetVerified ?? null, operationsSettledAttested: event.operationsSettled ?? null }))
  };
  const analysisSourceSha256 = Object.fromEntries(['analyze-workflow-collection.mjs', 'workflow-evidence-audit.mjs',
    'workflow-client-classifier.mjs', 'formal-collection.mjs', 'run-formal-healthy-release.mjs'].map(file =>
    [file, createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')]));
  const provenance = {
    analysisSourceSha256,
    schemaVersion: 1, toolVersion: version, protocolRevision: manifest?.protocolRevision ?? null,
    mode: mode === 'fixture' ? 'synthetic_fixture' : mode === 'formal' ? 'formal_collection_input' : 'unverified_input',
    scheduleId: manifest?.scheduleId ?? null, manifestHash: input.ledger?.manifestHash ?? null,
    collectionGitRevision: manifest?.gitRevision ?? null, seed: manifest?.seed ?? null,
    algorithm: manifest?.algorithm ?? null,
    environment: manifest?.frozen ? { fingerprint: manifest.frozen.environmentFingerprint,
      composeConfigSha256: manifest.frozen.composeConfigSha256, stableConfigSha256: manifest.frozen.stableConfigSha256,
      imageDigests: manifest.frozen.imageDigests } : null,
    selectionRule: 'Current WP4 round only. Original and superseded evidence remains in the inventory. Unresolved review excludes the pair.',
    pairedDifference: 'C minus H', quantileMethod: 'Linear interpolation at (n - 1) * p',
    provenanceStatus: audit.status, limitations
  };
  return { root: input.root, provenance, audit, pairs, scenarios: ['S1', 'S2', 'S3'].map(scenario => aggregate(pairs, scenario)) };
}

function markdown(report) {
  const { provenance, audit, scenarios } = report;
  const lines = ['# Workflow comparison evidence report', '',
    provenance.mode === 'synthetic_fixture' ? '**Synthetic fixture. These values are test results.**'
      : '**Offline descriptive report. Full collection provenance remains unverified.**', '',
    'Integrity state — ' + audit.status, 'Collection state — ' + audit.collectionState,
    'Schedule — ' + (provenance.scheduleId ?? 'unavailable'), '',
    'Paired differences are C minus H. Positive differences indicate a larger measured value under C.',
    'The JSON tables retain clock-bounded differences, censored episodes, unpaired arm distributions and categorical outcomes.',
    'Quartiles use linear interpolation at (n − 1) × p. See the JSON tables for individual paired values and evidence references.', ''];
  for (const scenario of scenarios) {
    lines.push('## ' + scenario.scenario, '',
      `Accepted ${scenario.acceptedPairs} of ${scenario.plannedPairs} planned pairs. ${scenario.attemptedArms} arms started across ${scenario.replacements} replacement rounds and the original plan.`, '',
      '| Measure | Numeric pairs | Categorical pairs | H median | C median | Median C − H | Range C − H | IQR C − H |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const [metric, stats] of Object.entries(scenario.measures)) {
      const d = stats.differencesCMinusH;
      const duration = metric.endsWith('_time') || ['observed_downtime', 'deployment_overhead'].includes(metric);
      const format = value => value == null ? '—' : duration ? (value / 1e6).toFixed(3) + ' ms' : String(value);
      lines.push(`| ${metric.replaceAll('_', ' ')} | ${stats.numericPairs} | ${stats.categoricalPairs} | ${format(stats.H?.median)} | ${format(stats.C?.median)} | ${format(d?.median)} | ${d ? format(d.min) + ' to ' + format(d.max) : '—'} | ${format(d?.iqr)} |`);
    }
    lines.push('', 'Validity counts — ' + JSON.stringify(scenario.validity),
      'Selection counts — ' + JSON.stringify(scenario.selectionStatuses), '');
    if (scenario.recoveryFlow) {
      const flow = scenario.recoveryFlow;
      lines.push(`S3 assigned-arm denominator ${flow.allAssigned}. Fault-acknowledged, adequately observed arms in accepted rounds ${flow.eligible}. In-window recovery ${flow.recoveredInWindow}. Supplementary late recovery observed ${flow.lateObserved}.`, '');
    }
  }
  return [...lines, '## Limitations', '', ...limitations.map(item => '- ' + item), ''].join('\n');
}

export function writeWorkflowReports(report, directory, { analysisGitRevision, analysisTimestamp } = {}) {
  const target = join(realpathSync(dirname(resolve(directory))), basename(resolve(directory)));
  if (inside(report.root, target)) throw new Error('Output directory must be outside the collection root');
  if (!/^[a-f0-9]{40}$/.test(analysisGitRevision ?? '') ||
      typeof analysisTimestamp !== 'string' || !Number.isFinite(Date.parse(analysisTimestamp)) || new Date(analysisTimestamp).toISOString() !== analysisTimestamp) {
    throw new Error('Provide exact analysis Git revision and ISO generation timestamp');
  }
  mkdirSync(target, { mode: 0o700 });
  const write = (name, content) => writeFileSync(join(target, name), content, { flag: 'wx', mode: 0o600 });
  const artifacts = {
    'integrity.json': report.audit, 'inventory.json': report.pairs, 'matched-pairs.json': report.scenarios,
    'provenance.json': { ...report.provenance, analysisGitRevision, analysisTimestamp }
  };
  for (const [name, value] of Object.entries(artifacts)) write(name, JSON.stringify(value, null, 2) + '\n');
  write('summary.md', markdown(report));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' } } });
    const [command, directory] = positionals;
    if (positionals.length !== 2 || !['audit', 'inspect', 'report'].includes(command) ||
        Boolean(values.out) !== (command === 'report')) {
      throw new Error('Usage: analyze-workflow-collection.mjs audit|inspect <collection> or report <collection> --out <new-directory>');
    }
    const report = analyzeWorkflowCollection(directory);
    if (command === 'audit') console.log(JSON.stringify(report.audit, null, 2));
    if (command === 'inspect') console.log(JSON.stringify({ provenance: report.provenance, inventory: report.pairs }, null, 2));
    if (command === 'report') {
      const git = await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8'
      });
      writeWorkflowReports(report, values.out, { analysisGitRevision: git.stdout.trim(),
        analysisTimestamp: new Date().toISOString() });
    }
    if (['blocked', 'trial_integrity_issues'].includes(report.audit.status)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
