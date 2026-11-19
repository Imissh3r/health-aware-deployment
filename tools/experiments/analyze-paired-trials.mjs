import { parseArgs } from 'node:util';
import { analyzePair } from './paired-trial-evidence.mjs';

function formatPair(pair) {
  const { A, B } = pair.arms;
  const percent = value => value === null ? '—' : (value * 100).toFixed(1) + '%';
  const seconds = value => value === null ? '—' : (value / 1000).toFixed(3) + ' s';
  const milliseconds = value => value === null ? '—' : value.toFixed(3) + ' ms';
  const rows = [];
  function compare(label, get, display = String) {
    rows.push([label, display(get(A)), display(get(B))]);
  }

  compare('Trial', arm => arm.trial_id);
  compare('Git commit', arm => arm.git.commit);
  compare('Working tree at measurement start', arm => arm.git.working_tree);
  compare('Scheduled requests', arm => arm.requests.scheduled);
  compare('Dispatched requests', arm => arm.requests.dispatched);
  for (const [label, outcome] of [
    ['Successful requests', 'ok'], ['HTTP errors', 'http_error'], ['Timeouts', 'timeout'],
    ['Connection errors', 'connection_error'], ['Missed requests', 'missed']
  ]) {
    compare(label, arm => arm.requests.outcomes[outcome]);
  }
  compare('Success rate', arm => arm.requests.success_rate, percent);
  compare('HTTP error rate', arm => arm.requests.http_error_rate, percent);
  compare('Successful latency p50', arm => arm.requests.successful_latency_ms.p50, milliseconds);
  compare('Successful latency p95', arm => arm.requests.successful_latency_ms.p95, milliseconds);
  compare('Fault-write start (driver offset)', arm => arm.recovery.fault_activation_offset_ms.started, seconds);
  compare('Fault acknowledgment (driver offset)', arm => arm.recovery.fault_activation_offset_ms.completed, seconds);
  for (const [label, key] of [
    ['Fault activation duration', 'fault_activation_duration_ms'],
    ['Fault acknowledgment → confirmation', 'fault_ack_to_confirmation_ms'],
    ['Confirmation → rollback start', 'confirmation_to_rollback_ms'],
    ['Configured operator delay', 'configured_operator_delay_ms'],
    ['Confirmation → reconfirmation', 'confirmation_to_reconfirmation_ms'],
    ['Rollback start → verified recovery', 'rollback_to_recovery_ms'],
    ['Fault acknowledgment → verified recovery', 'fault_ack_to_recovery_ms']
  ]) {
    compare(label, arm => arm.recovery[key], seconds);
  }
  return [
    'Verified A/B pair',
    'Requests scheduled in [15 s, 60 s). Rates use dispatched requests. Latency uses successful requests and nearest-rank percentiles.',
    '',
    '| Measurement | Arm A — automatic | Arm B — scripted delay |',
    '|---|---|---|',
    ...rows.map(row => '| ' + row.join(' | ') + ' |')
  ].join('\n');
}

try {
  const { values, positionals } = parseArgs({
    options: { json: { type: 'boolean' } },
    allowPositionals: true
  });
  if (positionals.length !== 2) {
    throw new Error('Usage: node tools/experiments/analyze-paired-trials.mjs [--json] <arm-a-dir> <arm-b-dir>');
  }
  const pair = analyzePair(...positionals);
  console.log(values.json ? JSON.stringify(pair, null, 2) : formatPair(pair));
} catch (error) {
  console.error('Pair analysis failed — ' + error.message);
  process.exitCode = 1;
}
