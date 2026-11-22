import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { classifyTrialEvidence } from './formal-trial-classifier.mjs';
import { readPublishedTrialBundle } from './formal-trial-bundle.mjs';
import { readAttemptRecords, summarizeFormalPairs } from './summarize-formal-pairs.mjs';

const windowStartMs = 15_000;
const windowEndMs = 60_000;
const outcomes = ['ok', 'http_error', 'timeout', 'connection_error', 'driver_error', 'interrupted', 'missed'];

export function measureHttpWindow(requests) {
  const counts = Object.fromEntries(outcomes.map(outcome => [outcome, 0]));
  const successfulLatencies = [];
  let scheduled = 0;
  for (const { scheduled_ms, outcome, latency_ms } of requests) {
    if (!Object.hasOwn(counts, outcome)) throw new Error('Unexpected Driver V1 outcome: ' + String(outcome));
    if (scheduled_ms < windowStartMs || scheduled_ms >= windowEndMs) continue;
    counts[outcome]++;
    scheduled++;
    if (outcome === 'ok') successfulLatencies.push(latency_ms);
  }
  // Driver V1 records one row per scheduled request, with missed rows marking unsent requests.
  const dispatched = scheduled - counts.missed;
  successfulLatencies.sort((a, b) => a - b);
  const samples = successfulLatencies.length;
  const percentile = fraction => samples === 0 ? null : successfulLatencies[Math.ceil(fraction * samples) - 1];
  return {
    scheduled, dispatched, outcomes: counts,
    http_error_rate: dispatched === 0 ? null : counts.http_error / dispatched,
    successful_latency_ms: { samples, p50: percentile(0.50), p95: percentile(0.95) }
  };
}

function analyzeAttempt(record) {
  const { trialId, directory, artifacts, evidence } = readPublishedTrialBundle(record.evidence_location);
  if (trialId !== record.trial_id || directory !== record.evidence_location || evidence.trial?.arm !== record.arm) {
    throw new Error('Bundle identity conflicts with attempt record: ' + record.trial_id);
  }
  for (const [name, artifact] of Object.entries(artifacts)) {
    const recorded = record.artifacts?.[name];
    if (recorded?.status !== artifact.status || recorded.sha256 !== artifact.sha256) {
      throw new Error('Bundle artifact differs from attempt record: ' + record.trial_id + '/' + name);
    }
  }
  const classification = classifyTrialEvidence(evidence);
  if (!isDeepStrictEqual(classification, record.classification) || classification.workloadUsability.status !== 'usable') {
    throw new Error('Selected attempt lacks a matching usable V1 workload: ' + record.trial_id);
  }

  const cutoff = classification.cutoffOutcome.status;
  const fault = evidence.events.find(event => event.event === 'fault_activated');
  return {
    trial_id: record.trial_id,
    cutoff_outcome: cutoff,
    recovery_timing: classification.recoveryEvidence.timing,
    recovery_time_ms: cutoff === 'recovered_in_window'
      ? classification.recoveryEvidence.verifiedAtMs - fault.wall_ms : null,
    requests: measureHttpWindow(evidence.requests)
  };
}

function difference(a, b, scale = 1) {
  return a === null || b === null ? null : scale * (b - a);
}

function summarizeDifferences(differences) {
  const sorted = differences.filter(value => value !== null).sort((a, b) => a - b);
  const pair_count = sorted.length;
  if (pair_count === 0) return { pair_count, median: null, q1: null, q3: null, iqr: null };

  const percentile = fraction => {
    const index = (pair_count - 1) * fraction;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return sorted[lower] + (index - lower) * (sorted[upper] - sorted[lower]);
  };
  const q1 = percentile(0.25);
  const q3 = percentile(0.75);
  return { pair_count, median: percentile(0.50), q1, q3, iqr: q3 - q1 };
}

export function analyzeFormalHttp(manifest, attemptRecords) {
  const selection = summarizeFormalPairs(manifest, attemptRecords);
  const records = new Map(attemptRecords.map(record => [record.trial_id, record]));
  const pairs = selection.pairs.filter(pair => pair.status === 'complete').map(pair => {
    const A = analyzeAttempt(records.get(pair.arms.A.selected_attempt.trial_id));
    const B = analyzeAttempt(records.get(pair.arms.B.selected_attempt.trial_id));
    return {
      pair_id: pair.pair_id, selected_round_id: pair.selected_round_id, arms: { A, B },
      differences: {
        http_error_rate_percentage_points: difference(A.requests.http_error_rate, B.requests.http_error_rate, 100),
        recovery_time_ms: difference(A.recovery_time_ms, B.recovery_time_ms)
      }
    };
  });
  const pairedEffects = {
    http_error_rate_percentage_points: summarizeDifferences(
      pairs.map(pair => pair.differences.http_error_rate_percentage_points)
    ),
    recovery_time_ms: summarizeDifferences(pairs.map(pair => pair.differences.recovery_time_ms))
  };
  return {
    schema_version: 2,
    window_ms: { start_inclusive: windowStartMs, end_exclusive: windowEndMs },
    rate_denominator: 'dispatched_requests',
    latency_percentile_method: 'nearest_rank',
    paired_effect_percentile_method: 'linear_interpolation',
    pair_counts: selection.pair_counts,
    recovery_time_pair_count: pairedEffects.recovery_time_ms.pair_count,
    paired_effects: pairedEffects,
    pairs
  };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
      throw new Error('Usage: node tools/experiments/analyze-formal-http.mjs MANIFEST ATTEMPT_LOG_DIR');
    }
    const [manifestPath, logDirectory] = args;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    console.log(JSON.stringify(analyzeFormalHttp(manifest, readAttemptRecords(logDirectory)), null, 2));
  } catch (error) {
    console.error('Formal HTTP analysis failed — ' + error.message);
    process.exitCode = 1;
  }
}
