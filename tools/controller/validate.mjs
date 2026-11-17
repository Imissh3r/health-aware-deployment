import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const workloadCount = 5;
const expectedVersion = '2.0.0';
const exitCodes = {
  ELIGIBLE_FOR_PROMOTION: 0,
  REJECTED: 2,
  INCONCLUSIVE: 3,
  FAILED: 1
};

function milliseconds(option, value) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < 1 || number > 2_147_483_647) {
    throw new Error(`--${option} must be a positive integer in the Node timer range`);
  }
  return number;
}

function settingsFromCli() {
  const { values } = parseArgs({
    options: {
      'timeout-ms': { type: 'string', default: '1500' },
      'max-latency-ms': { type: 'string', default: '1000' }
    }
  });
  return {
    expected_version: expectedVersion,
    required_attempts: workloadCount,
    timeout_ms: milliseconds('timeout-ms', values['timeout-ms']),
    max_latency_ms: milliseconds('max-latency-ms', values['max-latency-ms'])
  };
}

function readProbes(settings) {
  const source = readFileSync(new URL('./probe.mjs', import.meta.url), 'utf8');
  const command = spawnSync('docker', [
    'compose', '--profile', 'routing', 'exec', '-T', 'app',
    'node', '--input-type=module', '-',
    String(settings.timeout_ms), String(workloadCount)
  ], {
    cwd: new URL('../../', import.meta.url),
    input: source,
    encoding: 'utf8',
    timeout: (workloadCount + 2) * settings.timeout_ms + 5000
  });

  if (command.error) throw command.error;
  if (command.status !== 0) {
    throw new Error(command.stderr.trim() || `Probe process exited with status ${command.status}`);
  }

  const report = JSON.parse(command.stdout);
  if (!Array.isArray(report.health) || !Array.isArray(report.workload)) {
    throw new Error('Probe process returned an invalid report');
  }
  return report;
}

function evaluate({ health, workload }, settings) {
  const unhealthy = health.find(check => check.outcome !== 'ok');
  if (unhealthy?.outcome === 'http_error') {
    return ['REJECTED', `${unhealthy.endpoint} returned HTTP ${unhealthy.http_status}`];
  }
  if (health.length !== 2 || unhealthy || workload.length !== workloadCount) {
    return ['INCONCLUSIVE', 'Required health or workload observations are missing'];
  }

  const failures = workload.filter(row => row.outcome !== 'ok').length;
  if (failures > 0) return ['REJECTED', `${failures} of ${workload.length} workload attempts failed`];
  if (workload.some(row => row.version !== settings.expected_version)) {
    return ['REJECTED', 'Workload response did not identify the expected candidate version'];
  }
  if (workload.some(row => row.latency_ms > settings.max_latency_ms)) {
    return ['REJECTED', `A workload request exceeded ${settings.max_latency_ms} ms`];
  }
  return ['ELIGIBLE_FOR_PROMOTION', 'Candidate passed all validation checks'];
}

const startedAt = new Date().toISOString();
let settings;
let report;
let result;
try {
  settings = settingsFromCli();
  report = readProbes(settings);
  result = evaluate(report, settings);
} catch (error) {
  result = ['FAILED', error.message];
}

const event = {
  event: 'candidate_validation',
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  status: result[0],
  reason: result[1],
  settings
};

if (report) {
  const attempted = report.workload.length;
  const successful = report.workload.filter(row => row.outcome === 'ok').length;
  const failed = attempted - successful;
  event.workload_counts = {
    attempted,
    successful,
    failed,
    error_rate_percent: attempted ? (100 * failed) / attempted : null
  };
  event.probes = report;
}

console.log(JSON.stringify(event, null, 2));
process.exitCode = exitCodes[event.status];
