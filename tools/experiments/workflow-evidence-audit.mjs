import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual as equal } from 'node:util';
import { openCollection, validateCollectionManifest } from './formal-collection.mjs';
import { controllerResult, readWorkload } from './run-formal-healthy-release.mjs';
import { classifyWorkflowClient } from './workflow-client-classifier.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true });
const digest = /^[a-f0-9]{64}$/;
const trialStamp = /^\d+$/;
const windowNs = 60_000_000_000n;

export function inside(parent, path) {
  const rel = relative(parent, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

function entry(root, path) {
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error('path_outside_collection');
  let current = root;
  const parts = relative(root, target).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('unsafe_evidence_path');
    if (current === target) return stat;
    if (!stat.isDirectory()) throw new Error('invalid_evidence_parent');
  }
  return lstatSync(root);
}

function artifact(root, path, audit, parse = null, expected = null) {
  let bytes;
  let sha256;
  let status;
  try {
    const file = entry(root, path);
    if (!file) status = 'missing';
    else if (!file.isFile()) status = 'inconsistent';
    else {
      bytes = readFileSync(join(root, path));
      sha256 = hash(bytes);
      status = expected === null ? 'unverifiable' : sha256 === expected ? 'verified' : 'corrupted';
    }
  } catch {
    status = 'inconsistent';
  }
  const record = { path, status, ...(sha256 && { sha256 }) };
  audit.push(record);
  if (!bytes || status === 'corrupted') return undefined;
  try { return parse ? parse(decoder.decode(bytes)) : bytes; }
  catch { record.status = 'corrupted'; return undefined; }
}

function jsonl(text) {
  return text.trimEnd().split('\n').map(line => JSON.parse(line));
}

function inventory(manifest, events) {
  const pairs = manifest.pairs.map(pair => ({
    scenario: pair.scenario, pairId: pair.pairId, plannedOrder: pair.plannedOrder,
    attempts: [{ ...pair.original, disposition: 'current' }]
  }));
  const attempts = new Map(pairs.map(pair => [pair.attempts[0].attemptId, pair]));
  const arms = new Map();
  function add(attempt) {
    attempt.arms = attempt.arms.map(trial => ({ ...trial, status: 'planned', history: [] }));
    for (const arm of attempt.arms) arms.set(arm.trialId, arm);
  }
  for (const pair of pairs) add(pair.attempts[0]);
  for (const event of events) {
    if (event.type === 'pair_decision') {
      const pair = attempts.get(event.attemptId);
      const previous = pair.attempts.at(-1);
      previous.decision = { sequence: event.sequence, decision: event.decision,
        invalidTrialId: event.invalidTrialId ?? null, adjudicatedValidity: event.adjudicatedValidity ?? null,
        rerunOf: event.rerunOf ?? [] };
      previous.disposition = event.decision === 'replace' ? 'superseded' : 'retained_for_review';
      if (event.decision === 'replace') {
        const round = previous.round + 1;
        const attemptId = pair.pairId + '-r0' + round;
        const attempt = { round, attemptId, disposition: 'current', arms: previous.arms.map(arm => {
          const trialId = attemptId + '-' + arm.arm;
          return { scenario: arm.scenario, pairId: pair.pairId, position: arm.position,
            arm: arm.arm, round, attemptId, trialId, driverRunId: trialId + '-driver' };
        }) };
        add(attempt);
        pair.attempts.push(attempt);
        attempts.set(attemptId, pair);
      }
      continue;
    }
    const arm = arms.get(event.trial?.trialId ?? event.trialId);
    arm.history.push({ sequence: event.sequence, type: event.type });
    if (event.type === 'start') {
      arm.status = 'started';
      arm.start = event;
    } else if (event.type === 'interrupted') arm.status = 'interrupted';
    else if (event.type === 'preflight_blocked') arm.status = 'preflight_blocked';
    else if (event.type === 'outcome' || (event.type === 'reconcile' && event.outcome)) {
      arm.status = 'completed';
      arm.terminal = event;
    } else if (event.type === 'reconcile') {
      arm.reconciled = true;
      if (event.aborted) arm.status = 'aborted';
      else if (!arm.start) arm.status = 'planned';
    }
    if (event.type === 'reconcile') arm.reconciled = true;
  }
  return pairs;
}

function verifyEventSources(index, issue) {
  const probes = [...index.values()].filter(event => event.event === 'external_probe');
  const requirements = {
    external_alert: [500, '2.0.0'],
    candidate_externally_verified: [200, '2.0.0'],
    external_restoration_verified: [200, '1.0.0']
  };
  for (const event of index.values()) {
    for (const key of ['source_sample_ids', 'sample_ids', 'source_sample_id', 'source_event_id', 'action_id',
      'alert_id', 'write_start_id', 'detection_event_id', 'fault_confirmation_id', 'deployment_event_id']) {
      const ids = ['source_sample_ids', 'sample_ids'].includes(key) ? event[key] ?? [] : [event[key]];
      if (!Array.isArray(ids) || ids.some(id => id != null && !index.has(id))) issue('inconsistent', 'unlinked_derived_event');
    }
    const expected = Object.hasOwn(requirements, event.event) ? requirements[event.event] : null;
    if (expected) {
      const ids = event.source_sample_ids ?? event.sample_ids;
      const start = probes.findIndex(probe => probe.id === ids?.[0]);
      const streak = start < 0 ? [] : probes.slice(start, start + 3);
      if (ids?.length !== 3 || streak.length !== 3 || !streak.every((sample, i) =>
        sample.id === ids[i] && sample.observation?.http_status === expected[0] &&
        sample.observation?.version === expected[1]) || streak[2].host_monotonic_ns !== event.host_monotonic_ns) {
        issue('inconsistent', 'external_streak_source_conflict');
      }
    }
    if (event.event === 'fault_independently_confirmed') {
      const samples = event.source_sample_ids?.map(id => index.get(id)) ?? [];
      const expected = new Map([['/api/work', 500], ['/health', 200], ['/ready', 200]]);
      if (samples.length !== 3 || new Set(samples.map(sample => sample?.path)).size !== 3 ||
          samples.some(sample => sample?.event !== 'direct_candidate_precondition_probe' ||
            sample.source_clock_correlated !== true || !expected.has(sample.path) ||
            sample.observation?.http_status !== expected.get(sample.path) ||
            (sample.path === '/api/work' && sample.observation.version !== '2.0.0')) ||
          samples.at(-1)?.host_monotonic_ns !== event.host_monotonic_ns) {
        issue('inconsistent', 's2_fault_precondition_source_conflict');
      }
    }
    if (event.event === 'operator_restore_invoked') {
      const alert = index.get(event.alert_id);
      if (alert?.event !== 'external_alert' || !trialStamp.test(event.due_monotonic_ns ?? '') ||
          BigInt(event.due_monotonic_ns) - BigInt(alert.host_monotonic_ns) !== 10_000_000_000n ||
          BigInt(event.host_monotonic_ns) < BigInt(event.due_monotonic_ns)) {
        issue('inconsistent', 'operator_delay_source_conflict');
      }
    }
    if (['monitor_third_failure', 'monitor_locked_confirmation', 'automatic_restore_started'].includes(event.event)) {
      const source = index.get(event.source_event_id);
      const marker = event.event === 'monitor_third_failure' ? 'third_qualifying_failure' : 'locked_degradation_confirmed';
      if (source?.event !== 'monitor_timing_received' || source.marker?.event !== marker ||
          source.marker.occurred_monotonic_ns !== event.host_monotonic_ns ||
          BigInt(source.host_monotonic_ns) < BigInt(event.host_monotonic_ns)) {
        issue('inconsistent', 'monitor_occurrence_source_conflict');
      }
    }
  }
}

function auditTrial(root, prefix, trial, { frozen, gitRevision }) {
  const artifacts = [];
  const issues = [];
  const parse = (file, parser = JSON.parse) => artifact(root, join(prefix, file), artifacts, parser);
  const summary = parse('summary.json');
  const classifier = parse('classifier.json');
  const records = parse('events.jsonl', jsonl);
  const eventIndex = new Map();
  const issue = (status, code) => issues.push({ status, code });
  if (trial.terminal && summary && (!equal(summary, trial.terminal.outcome) || summary.classifier !== 'classifier.json')) {
    issue('inconsistent', 'summary_ledger_conflict');
  }
  if (records) {
    for (const [index, event] of records.entries()) {
      if (event?.id !== trial.trialId + ':' + (index + 1) ||
          typeof event.event !== 'string' || !trialStamp.test(event.host_monotonic_ns ?? '')) {
        issue('inconsistent', 'event_identity_or_clock');
        break;
      }
      eventIndex.set(event.id, event);
    }
    const start = records[0];
    if (start?.event !== 'trial_started' || start.trialId !== trial.trialId ||
        start.runId !== trial.driverRunId || start.arm !== trial.arm || start.scenario !== trial.scenario ||
        !frozen || !['project', 'proxyUrl', 'stableConfigSha256', 'environmentFingerprint']
          .every(key => start.frozen?.[key] === frozen[key])) issue('inconsistent', 'runner_start_identity');
  }
  const reference = (actual, code) => {
    if (!actual) return;
    const event = eventIndex.get(actual.id);
    if (!event || !Object.entries(actual).every(([key, value]) => equal(event[key], value))) {
      issue('inconsistent', code);
    }
  };
  if (records && summary) {
    for (const event of [summary.origin, summary.reset?.event, summary.cleanup?.event, summary.workflow?.alert,
      summary.workflow?.restore, summary.workflow?.restore_outcome, summary.observer?.stable_verification,
      summary.observer?.verification, summary.preparation?.acknowledgment, summary.preparation?.confirmation,
      summary.deployment_invocation, summary.fault_write_started, summary.candidate_verified,
      summary.workflow?.locked_confirmation, summary.workflow?.third_failure]) reference(event, 'summary_event_conflict');
    verifyEventSources(eventIndex, issue);
    const deployment = [...eventIndex.values()].find(event => event.event === 'deployment_returned');
    if (deployment) {
      if (deployment.outcome?.status && deployment.outcome.status !== summary.workflow?.deployment) {
        issue('inconsistent', 'deployment_summary_conflict');
      }
      const stdout = artifact(root, join(prefix, 'deployment.stdout.log'), artifacts, text => text);
      artifact(root, join(prefix, 'deployment.stderr.log'), artifacts);
      if (stdout !== undefined) {
        const execution = deployment.execution ?? deployment;
        const decoded = controllerResult({ stdout, exitCode: trial.scenario === 'S1' ? execution.exitCode : execution.exit_code,
          signal: execution.signal,
          timedOut: execution.timed_out }, trial.arm);
        if (!equal(decoded, deployment.outcome ?? null)) issue('inconsistent', 'controller_stdout_conflict');
      }
    }
  }
  const input = classifier?.inputs;
  if (input && records) {
    for (const event of [input.origin, input.deployment, input.faultWriteStarted, input.restore,
      input.intervention, input.externalVerification, input.prevention?.rejected, input.prevention?.stableContinuity]) {
      reference(event, 'classifier_event_conflict');
    }
    const primary = input.origin;
    const originKind = trial.scenario === 'S3' ? 'fault_write_acknowledged' : 'deployment_invoked';
    if (primary && (primary.event !== originKind || !trialStamp.test(primary.host_monotonic_ns ?? '') ||
        !trialStamp.test(primary.cutoff_ns ?? '') ||
        BigInt(primary.cutoff_ns) - BigInt(primary.host_monotonic_ns) !== windowNs)) issue('inconsistent', 'incorrect_primary_origin_or_cutoff');
    if ((primary?.id ?? null) !== (summary?.origin?.id ?? null) && summary) issue('inconsistent', 'classifier_origin_conflict');
    if (trial.scenario === 'S2' && primary && (!primary.fault_confirmation_id ||
      summary?.preparation?.confirmation?.id !== primary.fault_confirmation_id ||
      !eventIndex.has(primary.fault_confirmation_id))) issue('inconsistent', 's2_fault_precondition_unlinked');
    if (summary?.workflow?.restore?.id !== input.restore?.id) issue('inconsistent', 'classifier_restore_conflict');
    const restoreKind = trial.arm === 'H' ? 'automatic_restore_started' : 'operator_restore_invoked';
    if (input.restore && (input.restore.event !== restoreKind || input.restore.role !== 'normal_workflow_restore')) {
      issue('inconsistent', 'non_workflow_restore_attribution');
    }
  }

  let workload;
  let result;
  let clockVerified = false;
  let earlyCleanup = false;
  if (classifier) {
    const paths = [['run', 'run.json'], ['requests', 'requests.csv']];
    let canRead = true;
    for (const [key, filename] of paths) {
      const path = join(trial.driverRunId, filename);
      const ref = classifier.files?.[key];
      if (ref?.path !== path) {
        issue('inconsistent', 'workload_path_conflict');
        canRead = false;
        continue;
      }
      const expected = typeof ref.sha256 === 'string' && digest.test(ref.sha256) ? ref.sha256 : null;
      if (!artifact(root, join(prefix, path), artifacts, null, expected) || !expected) canRead = false;
    }
    if (canRead) {
      workload = readWorkload(join(root, prefix), trial.driverRunId);
      if (Object.entries(workload).some(([key, file]) => file.sha256 !== classifier.files[key].sha256)) {
        issue('corrupted', 'driver_evidence_changed_during_audit');
        workload = undefined;
      }
    }
    if (workload && Object.values(workload).some(({ error }) => error)) issue('corrupted', 'invalid_driver_format');
    else if (workload && (workload.run.value?.run_id !== trial.driverRunId ||
      input?.arm !== trial.arm || input.scenario !== trial.scenario ||
      input.expectedTargetUrl !== frozen?.proxyUrl)) issue('inconsistent', 'classifier_identity_or_target');
    else if (workload) {
      const run = workload.run.value;
      if (!/^[a-f0-9]{40}$/.test(run.git?.commit ?? '') ||
          !['clean', 'dirty'].includes(run.git?.working_tree)) issue('unverifiable', 'driver_git_provenance_unavailable');
      else if (run.git.commit !== gitRevision || run.git.working_tree !== 'clean') {
        issue('inconsistent', 'driver_git_provenance_conflict');
      }
      const args = { ...input, run, requests: workload.requests.value };
      const log = [...eventIndex.values()];
      const notifications = log.filter(event => event.event === 'driver_start_notification_received');
      const reconciliations = log.filter(event => event.event === 'driver_clock_reconciliation');
      clockVerified = notifications.length === 1 && reconciliations.length === 1 &&
        reconciliations[0].passed === true && notifications[0].payload?.event === 'driver_start' &&
        notifications[0].payload.run_id === trial.driverRunId &&
        ['source', 'version', 'start_before_ns', 'start_after_ns'].every(key =>
          run.clock_alignment?.[key] !== undefined &&
          run.clock_alignment[key] === notifications[0].payload?.clock_alignment?.[key]);
      try {
        const derive = intervention => {
          const replay = classifyWorkflowClient({ ...args, ...intervention });
          if (classifier.supportingPreFaultInputs) {
            const expected = { ...input, recoveryApplicable: false };
            if (trial.scenario !== 'S3' || input.origin || !equal(classifier.supportingPreFaultInputs, expected)) {
              throw new Error('Conflicting pre-fault classifier inputs');
            }
            replay.candidate = classifyWorkflowClient({ ...args, ...expected, ...intervention }).candidate;
          }
          return replay;
        };
        const replay = derive({});
        if (!equal(replay, classifier.result)) issue('inconsistent', 'classifier_replay_conflict');
        else if ((summary?.workflow?.recovery && !equal(summary.workflow.recovery, replay.recovery)) ||
          (summary?.workflow?.prevention && !equal(summary.workflow.prevention, replay.prevention))) {
          issue('inconsistent', 'summary_classifier_conflict');
        } else {
          const cleanup = log.filter(event => ['cleanup_restore_started', 'cleanup_restore_invoked',
            'cleanup_fault_clear_invoked', 'manual_intervention', 'emergency_intervention'].includes(event.event)).sort((a, b) =>
            BigInt(a.host_monotonic_ns) < BigInt(b.host_monotonic_ns) ? -1 : 1)[0];
          earlyCleanup = Boolean(cleanup && replay.window &&
            BigInt(cleanup.host_monotonic_ns) < BigInt(replay.window.cutoff[0]));
          result = cleanup && replay.trace.drainEnd &&
            BigInt(cleanup.host_monotonic_ns) < BigInt(replay.trace.drainEnd[1])
            ? derive({ intervention: cleanup }) : replay;
        }
      } catch {
        issue('inconsistent', 'classifier_replay_failed');
      }
    }
  }
  if (entry(root, prefix)?.isDirectory()) {
    for (const file of readdirSync(join(root, prefix)).sort().filter(file => /\.(stdout|stderr)\.log$/.test(file) && !file.startsWith('deployment.'))) {
      artifact(root, join(prefix, file), artifacts);
    }
  }
  return { artifacts, issues, summary, result, clockVerified, earlyCleanup, eventIndex, requests: workload?.requests.value };
}

export function auditWorkflowCollection(directory) {
  const root = realpathSync(directory);
  const artifacts = [];
  const issues = [];
  const parsed = artifact(root, 'manifest.json', artifacts, JSON.parse);
  let wrapper;
  let ledger;
  let pairs = [];
  const trialEvidence = new Map();
  if (parsed) {
    try {
      validateCollectionManifest(parsed.manifest);
      if (!['formal', 'fixture'].includes(parsed.mode)) throw new Error('collection_mode');
      wrapper = parsed;
      pairs = inventory(wrapper.manifest, []);
    } catch {
      issues.push({ status: 'inconsistent', code: 'manifest_validation_failed' });
    }
  }
  if (wrapper) {
    try {
      if (!entry(root, 'ledger')?.isDirectory()) {
        issues.push({ status: 'missing', code: 'ledger_directory_unavailable' });
        throw new Error('missing');
      }
      const recorded = readdirSync(join(root, 'ledger')).sort().filter(file => !file.startsWith('.pending-')).map(file =>
        artifact(root, join('ledger', file), artifacts, JSON.parse));
      if (recorded.some(event => !event)) throw new Error('ledger_artifact');
      const replay = openCollection(root).inspect();
      if (replay.manifestHash !== hash(JSON.stringify({ mode: wrapper.mode, manifest: wrapper.manifest })) ||
          !equal(recorded, replay.events)) throw new Error('collection_changed_during_audit');
      ledger = replay;
      pairs = inventory(wrapper.manifest, ledger.events);
      const evidenceRoot = wrapper.mode === 'fixture' ? 'fixture-evidence' : 'trial-evidence';
      const trials = pairs.flatMap(pair => pair.attempts.flatMap(attempt => attempt.arms));
      if (entry(root, evidenceRoot)?.isDirectory()) {
        const started = new Set(trials.filter(trial => trial.start).map(trial => trial.trialId));
        for (const trialId of readdirSync(join(root, evidenceRoot))) {
          if (!started.has(trialId)) issues.push({ status: 'inconsistent', code: 'unregistered_evidence_entry' });
        }
      }
      for (const trial of trials.filter(trial => trial.start)) {
        try {
          trialEvidence.set(trial.trialId, auditTrial(root, join(evidenceRoot, trial.trialId), trial, wrapper.manifest));
        } catch {
          trialEvidence.set(trial.trialId, { artifacts: [], issues: [{ status: 'inconsistent', code: 'unsafe_or_unreadable_trial_path' }] });
        }
      }
    } catch {
      issues.push({ status: 'inconsistent', code: 'ledger_replay_or_path_failed' });
    }
  }
  const frozen = ledger && wrapper.manifest.frozen;
  if (frozen) {
    for (const [ref, expected] of [[frozen.composeConfigRef, frozen.composeConfigSha256], [frozen.preflightRef, null]]) {
      if (inside(root, resolve(root, ref)) && !ref.startsWith('fixture:')) {
        artifact(root, relative(root, resolve(root, ref)), artifacts, null, expected);
      } else {
        issues.push({ status: 'unverifiable', code: 'external_or_opaque_environment_reference' });
      }
    }
  }
  issues.push({ status: 'unverifiable', code: 'no_collection_bound_source_or_full_artifact_digest_index' });
  return { root, wrapper, ledger, artifacts, issues, pairs, trialEvidence };
}
