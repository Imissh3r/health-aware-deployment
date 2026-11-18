import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { readRoutingState, writeAtomic } from '../controller/deployment-state.mjs';
import { configPath } from '../controller/nginx-routing.mjs';
import { observeProxy } from '../controller/observe-proxy.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const resultsDir = join(repoRoot, 'experiments', 'results');
const services = ['db', 'app', 'candidate', 'nginx'];
const faultFlag = '/tmp/health-aware-workload-fault';
const exec = promisify(execFile);

function parseTrialArgs() {
  const { values, tokens } = parseArgs({
    options: {
      arm: { type: 'string' },
      'trial-id': { type: 'string' },
      'preflight-only': { type: 'boolean' }
    },
    tokens: true
  });
  const names = tokens.map(token => token.name);
  if (new Set(names).size !== names.length) throw new Error('Each option may be supplied only once');
  if (values.arm !== 'A' && values.arm !== 'B') throw new Error('--arm must be A or B');
  if (!values['preflight-only']) throw new Error('Stage 1 requires --preflight-only');

  const id = values['trial-id'] ?? `pilot-${values.arm.toLowerCase()}-${randomUUID()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error('--trial-id must start with a letter or digit and use only letters, digits, dots, dashes, or underscores');
  }
  return { arm: values.arm, trial_id: id };
}

function reserveTrial(trialId) {
  const runDir = join(resultsDir, trialId);
  const stageDir = join(resultsDir, '.staging', trialId);
  if (existsSync(runDir)) throw new Error('Result directory already exists for this trial ID');
  mkdirSync(join(resultsDir, '.staging'), { recursive: true });
  try {
    mkdirSync(stageDir, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Staged evidence already exists for this trial ID');
    throw error;
  }
  return { run_dir: runDir, staging_dir: stageDir };
}

async function compose(...args) {
  const command = exec('docker', ['compose', '--profile', 'routing', ...args], {
    cwd: repoRoot, encoding: 'utf8', timeout: 10_000
  });
  command.child.stdin?.end();
  return (await command).stdout.trim();
}

function composeServices(output) {
  // Compose versions emit either a JSON array or one JSON object per line.
  const rows = output.startsWith('[')
    ? JSON.parse(output)
    : output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return Object.fromEntries(services.map(service => [
    service,
    rows.filter(row => row.Service === service).map(row => ({
      state: row.State,
      health: row.Health || null
    }))
  ]));
}

async function checkPreflight(checks) {
  checks.routing_state = readRoutingState();
  if (checks.routing_state.deployment_id !== null || checks.routing_state.pending_deployment_id !== null) {
    throw new Error('Active and pending deployment IDs must both be null');
  }

  const config = readFileSync(configPath, 'utf8');
  checks.config_upstreams = Array.from(
    config.matchAll(/^[\t ]*proxy_pass[\t ]+([^;\r\n]+);/gm), match => match[1]
  );
  if (checks.config_upstreams.length !== 1 || checks.config_upstreams[0] !== 'http://app:3000') {
    throw new Error('The installed Nginx config must point to stable app:3000');
  }

  checks.services = composeServices(await compose('ps', '--all', '--format', 'json', ...services));
  for (const service of services) {
    const [container] = checks.services[service];
    if (checks.services[service].length !== 1 || container.state !== 'running') {
      throw new Error(`Expected one running container for ${service}`);
    }
    // Nginx has no healthcheck in this stack. Its live route is probed below.
    if (container.health !== 'healthy' && (service !== 'nginx' || container.health !== null)) {
      throw new Error(`Expected a healthy container for ${service}`);
    }
  }

  const flagState = await compose('exec', '-T', 'candidate', 'sh', '-c',
    'if test -e "$1"; then printf present; else printf absent; fi', 'sh', faultFlag);
  if (flagState !== 'present' && flagState !== 'absent') {
    throw new Error('Could not read the candidate fault flag state');
  }
  checks.candidate_fault_flag = flagState;
  if (flagState === 'present') throw new Error('The candidate fault flag must be absent');

  checks.proxy = await observeProxy(1000);
  if (checks.proxy.http_status !== 200 || checks.proxy.version !== '1.0.0') {
    throw new Error('Nginx must return HTTP 200 from stable version 1.0.0');
  }
}

const report = { event: 'pilot_preflight', started_at: new Date().toISOString(), checks: {} };
try {
  Object.assign(report, parseTrialArgs());
  Object.assign(report, reserveTrial(report.trial_id));
  await checkPreflight(report.checks);
  report.status = 'PREFLIGHT_PASSED';
} catch (error) {
  report.status = 'PREFLIGHT_FAILED';
  report.reason = error.message;
}
report.completed_at = new Date().toISOString();
if (report.staging_dir) {
  try {
    writeAtomic(join(report.staging_dir, 'preflight.json'), JSON.stringify(report, null, 2) + '\n');
  } catch (error) {
    report.status = 'PREFLIGHT_FAILED';
    report.evidence_error = error.message;
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PREFLIGHT_PASSED') process.exitCode = 1;
