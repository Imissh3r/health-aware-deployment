import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const arms = ['A', 'B'];
const outcomes = ['recovered_in_window', 'not_recovered_by_cutoff', 'unknown'];
const dispositions = ['not_run', 'interrupted_without_bundle'];
const validId = id => typeof id === 'string' && idPattern.test(id);

function indexManifest(manifest) {
  if (manifest?.schema_version !== 2 || !Array.isArray(manifest.pairs)) {
    throw new Error('Expected a schema_version 2 manifest with ordered rounds for each pair');
  }

  const plans = new Map();
  const assignments = new Map();
  for (const entry of manifest.pairs) {
    if (!validId(entry?.pair_id)) throw new Error('Invalid pair ID in execution manifest');
    const pairId = entry.pair_id;
    let plan = plans.get(pairId);
    if (plan) {
      plan.conflicts.add('DUPLICATE_PAIR_PLAN');
    } else {
      plan = { order: entry.assigned_order ?? null, rounds: [], conflicts: new Set() };
      plans.set(pairId, plan);
    }
    if (!['AB', 'BA'].includes(plan.order)) plan.conflicts.add('INVALID_ASSIGNED_ORDER');
    if (!Array.isArray(entry.rounds)) {
      plan.conflicts.add('MISSING_EXECUTION_ORDER');
      continue;
    }

    for (const round of entry.rounds) {
      if (!validId(round?.round_id) || !Array.isArray(round.attempts)) {
        throw new Error('Invalid round in execution manifest for ' + pairId);
      }
      if (plan.rounds.some(previous => previous.round_id === round.round_id)) {
        plan.conflicts.add('DUPLICATE_ROUND_ID');
      }
      plan.rounds.push(round);
      for (const slot of round.attempts) {
        if (!validId(slot?.trial_id) || !arms.includes(slot.arm)) {
          throw new Error('Invalid trial ID or arm in execution manifest for ' + pairId);
        }
        if (Object.hasOwn(slot, 'disposition') &&
            (!dispositions.includes(slot.disposition?.status) ||
             typeof slot.disposition.reason !== 'string' || !slot.disposition.reason.trim())) {
          throw new Error('Invalid unrecorded-attempt disposition for ' + slot.trial_id);
        }
        const previous = assignments.get(slot.trial_id);
        if (previous) {
          plan.conflicts.add('DUPLICATE_TRIAL_ASSIGNMENT');
          plans.get(previous.pairId).conflicts.add('DUPLICATE_TRIAL_ASSIGNMENT');
        } else {
          assignments.set(slot.trial_id, { pairId, arm: slot.arm });
        }
      }
      if (round.attempts.map(slot => slot.arm).join('') !== plan.order) {
        plan.conflicts.add('ARM_ORDER_CONFLICT');
      }
    }
  }
  return { plans, assignments };
}

function validateRecord(record) {
  const classification = record?.classification;
  if (record?.schema_version !== 1 || !validId(record.pair_id) || !validId(record.trial_id) ||
      record.attempt_id !== record.trial_id || !arms.includes(record.arm) || classification?.classifierVersion !== '1' ||
      !['valid', 'invalid'].includes(classification.attemptValidity?.status) ||
      !outcomes.includes(classification.cutoffOutcome?.status) ||
      !['verified', 'unverified', 'untrusted'].includes(classification.recoveryEvidence?.status) ||
      ![null, 'in_window', 'late'].includes(classification.recoveryEvidence.timing) ||
      !Array.isArray(classification.cutoffOutcome.reasonCodes) || !Array.isArray(classification.reviewFlags)) {
    throw new Error('Invalid V1 attempt record: ' + (record?.trial_id ?? '(missing trial ID)'));
  }
}

function attemptSummary(record) {
  return {
    trial_id: record.trial_id,
    arm: record.arm,
    record_status: 'recorded',
    attempt_validity: record.classification.attemptValidity,
    cutoff_outcome: record.classification.cutoffOutcome,
    recovery_evidence: record.classification.recoveryEvidence,
    review_flags: record.classification.reviewFlags
  };
}

function summarizeRound(round, records, pairId, reviewFlags) {
  const { round_id } = round;
  const attempts = round.attempts.map(({ arm, trial_id, disposition }) => {
    const record = records.get(trial_id);
    if (!record) {
      if (disposition) return { trial_id, arm, record_status: 'not_recorded', disposition };
      reviewFlags.push({ code: 'PLANNED_ATTEMPT_NOT_RECORDED', round_id, arm, trial_id });
      return { trial_id, arm, record_status: 'missing' };
    }
    if (record.pair_id !== pairId || record.arm !== arm) {
      return { trial_id, arm, record_status: 'conflict' };
    }
    if (disposition) {
      reviewFlags.push({ code: 'ATTEMPT_DISPOSITION_CONFLICT', round_id, arm, trial_id });
      return { ...attemptSummary(record), record_status: 'conflict', disposition };
    }
    return attemptSummary(record);
  });
  let status = 'invalid';
  if (attempts.some(attempt => attempt.record_status === 'conflict')) status = 'unresolved';
  else if (attempts.some(attempt => attempt.record_status === 'missing')) status = 'incomplete';
  else if (attempts.length === 2 && attempts.every(attempt => attempt.attempt_validity?.status === 'valid')) status = 'valid';
  return { round_id, status, attempts };
}

export function summarizeFormalPairs(manifest, attemptRecords) {
  const { plans, assignments } = indexManifest(manifest);
  const records = new Map();
  const recordsByPair = new Map();
  const provenanceFlags = new Map();
  function flag(pairId, code, record) {
    if (!provenanceFlags.has(pairId)) provenanceFlags.set(pairId, []);
    provenanceFlags.get(pairId).push({ code, arm: record.arm, trial_id: record.trial_id });
  }
  for (const record of attemptRecords) validateRecord(record);
  for (const record of attemptRecords.toSorted((a, b) => a.trial_id.localeCompare(b.trial_id))) {
    if (records.has(record.trial_id)) throw new Error('Duplicate attempt record: ' + record.trial_id);
    records.set(record.trial_id, record);
    if (!recordsByPair.has(record.pair_id)) recordsByPair.set(record.pair_id, []);
    recordsByPair.get(record.pair_id).push(record);
    const assignment = assignments.get(record.trial_id);
    if (!assignment) {
      flag(record.pair_id, 'ATTEMPT_NOT_IN_MANIFEST', record);
    } else if (assignment.pairId !== record.pair_id || assignment.arm !== record.arm) {
      flag(assignment.pairId, 'ATTEMPT_PROVENANCE_CONFLICT', record);
      if (assignment.pairId !== record.pair_id) flag(record.pair_id, 'ATTEMPT_PROVENANCE_CONFLICT', record);
    }
  }

  const pairCounts = { complete: 0, incomplete: 0, unresolved: 0 };
  const cutoffCounts = Object.fromEntries(arms.map(arm =>
    [arm, { recovered_in_window: 0, not_recovered_by_cutoff: 0, unknown: 0, verified_late: 0 }]));
  const pairs = [];
  for (const pairId of new Set([...plans.keys(), ...recordsByPair.keys()])) {
    const plan = plans.get(pairId);
    const conflicts = plan ? [...plan.conflicts] : ['MISSING_EXECUTION_ORDER'];
    const reviewFlags = [
      ...conflicts.map(code => ({ code })), ...(provenanceFlags.get(pairId) ?? [])
    ];
    const planUnresolved = reviewFlags.length > 0;
    const pairRecords = recordsByPair.get(pairId) ?? [];
    for (const record of pairRecords) {
      if (record.classification.cutoffOutcome.reasonCodes.includes('EVIDENCE_CONFLICT')) {
        reviewFlags.push({ code: 'EVIDENCE_CONFLICT', arm: record.arm, trial_id: record.trial_id });
      }
    }
    const rounds = (plan?.rounds ?? []).map(round => summarizeRound(round, records, pairId, reviewFlags));
    const firstValidIndex = rounds.findIndex(round => round.status === 'valid');
    const earlierIncomplete = firstValidIndex >= 0
      ? rounds.slice(0, firstValidIndex).filter(round => round.status === 'incomplete') : [];
    if (earlierIncomplete.length > 0) {
      reviewFlags.push({ code: 'EARLIER_ROUND_INCOMPLETE', round_ids: earlierIncomplete.map(round => round.round_id) });
    }
    const unresolved = planUnresolved || earlierIncomplete.length > 0 || rounds.some(round => round.status === 'unresolved');
    const selected = unresolved ? null : rounds[firstValidIndex] ?? null;
    const status = unresolved ? 'unresolved' : selected ? 'complete' : 'incomplete';
    if (selected) {
      const laterRecorded = rounds.slice(firstValidIndex + 1)
        .filter(round => round.attempts.some(attempt => attempt.record_status === 'recorded'));
      if (laterRecorded.length > 0) {
        reviewFlags.push({ code: 'ATTEMPT_AFTER_VALID_ROUND', round_ids: laterRecorded.map(round => round.round_id) });
      }
    }
    const armSummaries = Object.fromEntries(arms.map(arm => [arm, {
      selected_attempt: selected?.attempts.find(attempt => attempt.arm === arm) ?? null
    }]));
    pairCounts[status]++;
    if (status === 'complete') {
      for (const arm of arms) {
        const attempt = armSummaries[arm].selected_attempt;
        cutoffCounts[arm][attempt.cutoff_outcome.status]++;
        if (attempt.recovery_evidence.status === 'verified' && attempt.recovery_evidence.timing === 'late') {
          cutoffCounts[arm].verified_late++;
        }
      }
    }
    const slots = (plan?.rounds ?? []).flatMap(round => round.attempts);
    const unassigned = pairRecords.filter(record =>
      !slots.some(slot => slot.trial_id === record.trial_id && slot.arm === record.arm));
    pairs.push({
      pair_id: pairId, assigned_order: plan?.order ?? null, status, selected_round_id: selected?.round_id ?? null,
      arms: armSummaries, rounds, unassigned_attempts: unassigned.map(attemptSummary), review_flags: reviewFlags
    });
  }
  return { schema_version: 2, pair_counts: pairCounts, cutoff_counts: cutoffCounts, pairs };
}

export function readAttemptRecords(directory) {
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name.endsWith('.json'))
    .map(entry => {
      if (!entry.isFile()) throw new Error('Attempt record must be a regular file: ' + entry.name);
      const record = JSON.parse(readFileSync(join(directory, entry.name), 'utf8'));
      if (entry.name !== record?.trial_id + '.json') {
        throw new Error('Attempt record filename conflicts with its trial ID: ' + entry.name);
      }
      return record;
    });
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
      throw new Error('Usage: node tools/experiments/summarize-formal-pairs.mjs MANIFEST ATTEMPT_LOG_DIR');
    }
    const [manifestPath, logDirectory] = args;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    console.log(JSON.stringify(summarizeFormalPairs(manifest, readAttemptRecords(logDirectory)), null, 2));
  } catch (error) {
    console.error('Formal pair summary failed — ' + error.message);
    process.exitCode = 1;
  }
}
