import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

const stableConfig = 'location / {\n    proxy_pass http://app:3000;\n}\n';
const emptyRouting = { deployment_id: null, pending_deployment_id: null };
const healthyServices = ['db', 'app', 'candidate', 'nginx'].map(Service => ({
  Service, State: 'running', Health: Service === 'nginx' ? '' : 'healthy'
}));
const psArgs = ['ps', '--all', '--format', 'json', 'db', 'app', 'candidate', 'nginx'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pilot-preflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controllers = join(root, 'tools/controller');
  const experiments = join(root, 'tools/experiments');
  const bin = join(root, 'bin');
  const config = join(root, 'runtime/nginx/conf.d');
  const deployments = join(root, 'deployments');
  for (const directory of [controllers, experiments, bin, config, deployments]) {
    await mkdir(directory, { recursive: true });
  }
  for (const name of ['deployment-state.mjs', 'nginx-routing.mjs', 'observe-proxy.mjs']) {
    await copyFile(new URL('../controller/' + name, import.meta.url), join(controllers, name));
  }
  for (const name of ['run-paired-pilot.mjs', 'pilot-process.mjs', 'pilot-trial.mjs']) {
    await copyFile(new URL(name, import.meta.url), join(experiments, name));
  }
  const cli = join(experiments, 'run-paired-pilot.mjs');
  const configPath = join(config, 'default.conf');
  const statePath = join(deployments, 'active-deployment.json');
  const callsPath = join(root, 'compose-calls');
  const results = join(root, 'experiments/results');
  const preload = join(root, 'proxy.mjs');
  await writeFile(configPath, stableConfig);
  await writeFile(statePath, JSON.stringify(emptyRouting));
  await writeFile(preload, `
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import timers from 'node:timers/promises';
import { syncBuiltinESMExports } from 'node:module';
const sleep = timers.setTimeout;
timers.setTimeout = async (ms, value, options) => {
  if (ms !== 15000 || !process.env.PILOT_TRIAL_MODE) return sleep(ms, value, options);
  while (!existsSync(join(process.env.PILOT_FIXTURE, 'driver-ready'))) {
    await sleep(5, undefined, options);
  }
  return value;
};
syncBuiltinESMExports();
globalThis.fetch = async url => {
  if (url !== 'http://127.0.0.1:8080/api/work') throw new Error('Unexpected proxy URL');
  const version = process.env.PILOT_TRIAL_MODE === 'reset-failed' &&
    existsSync(join(process.env.PILOT_FIXTURE, 'monitor-finished')) ? '2.0.0' : process.env.PILOT_PROXY_VERSION;
  return new Response(JSON.stringify({ version }), { status: 200 });
};
`);
  await writeFile(join(bin, 'docker'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const { appendFileSync, existsSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 3), ['compose', '--profile', 'routing']);
const command = args.slice(3);
appendFileSync(process.env.PILOT_COMPOSE_CALLS, JSON.stringify(command) + '\\n');
const root = process.env.PILOT_FIXTURE;
const flag = join(root, 'candidate-fault');
if (command[0] === 'ps') {
  assert.deepEqual(command, ${JSON.stringify(psArgs)});
  const rows = JSON.parse(process.env.PILOT_SERVICES);
  console.log(process.env.PILOT_LIST_FORMAT === 'array' ? JSON.stringify(rows) : rows.map(row => JSON.stringify(row)).join('\\n'));
} else if (process.env.PILOT_TRIAL_MODE && command[0] === 'exec' && command[3] === 'touch') {
  assert.deepEqual(command, ['exec', '-T', 'candidate', 'touch', '/tmp/health-aware-workload-fault']);
  assert.ok(existsSync(join(root, 'driver-ready')));
  writeFileSync(flag, '');
} else if (process.env.PILOT_TRIAL_MODE && command[0] === 'exec' && command[3] === 'rm') {
  assert.deepEqual(command, ['exec', '-T', 'candidate', 'rm', '-f', '/tmp/health-aware-workload-fault']);
  assert.ok(existsSync(join(root, 'driver-finished')), 'cleanup preceded driver exit');
  rmSync(flag, { force: true });
} else {
  assert.deepEqual(command, ['exec', '-T', 'candidate', 'sh', '-c',
    'if test -e "$1"; then printf present; else printf absent; fi',
    'sh', '/tmp/health-aware-workload-fault']);
  console.log(existsSync(flag) ? 'present' : process.env.PILOT_FAULT);
}
`, { mode: 0o700 });

  function run(args, env = {}) {
    const result = spawnSync(process.execPath, ['--import', preload, cli, ...args], {
      cwd: bin,
      encoding: 'utf8',
      timeout: 8000,
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        PILOT_COMPOSE_CALLS: callsPath,
        PILOT_FIXTURE: root,
        PILOT_FAULT: 'absent',
        PILOT_LIST_FORMAT: 'lines',
        PILOT_PROXY_VERSION: '1.0.0',
        PILOT_SERVICES: JSON.stringify(healthyServices),
        ...env
      }
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return { exit: result.status, report: JSON.parse(result.stdout) };
  }
  return { root, run, results, callsPath, configPath, statePath };
}

for (const [arm, format] of [['A', 'lines'], ['B', 'array']]) {
  test(`preflights arm ${arm} with Compose ${format} JSON and stages only preflight evidence`, async t => {
    const lab = await fixture(t);
    const { exit, report } = lab.run(['--arm', arm, '--preflight-only'], { PILOT_LIST_FORMAT: format });
    assert.equal(exit, 0);
    assert.equal(report.status, 'PREFLIGHT_PASSED');
    assert.equal(report.arm, arm);
    assert.match(report.trial_id, new RegExp('^pilot-' + arm.toLowerCase() + '-'));
    assert.deepEqual(report.checks.routing_state, emptyRouting);
    assert.deepEqual(report.checks.proxy, { http_status: 200, version: '1.0.0' });
    assert.equal(report.checks.candidate_fault_flag, 'absent');
    const evidence = JSON.parse(await readFile(join(report.staging_dir, 'preflight.json'), 'utf8'));
    assert.deepEqual(evidence, report);
    assert.equal(report.run_dir, join(lab.results, report.trial_id));
    assert.equal(existsSync(report.run_dir), false);
    assert.equal(await readFile(lab.configPath, 'utf8'), stableConfig);
    assert.equal(await readFile(lab.statePath, 'utf8'), JSON.stringify(emptyRouting));
    const calls = (await readFile(lab.callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], psArgs);
    assert.deepEqual(calls[1].slice(0, 4), ['exec', '-T', 'candidate', 'sh']);
  });
}

test('rejects unsupported arms, unsafe IDs, duplicate options, and missing arms before staging', async t => {
  const lab = await fixture(t);
  for (const args of [
    ['--arm', 'C', '--preflight-only'],
    ['--arm', 'A', '--preflight-only', '--trial-id', '../../outside'],
    ['--arm', 'A', '--arm', 'B', '--preflight-only'],
    ['--preflight-only']
  ]) {
    const { exit, report } = lab.run(args);
    assert.equal(exit, 1);
    assert.equal(report.status, 'PREFLIGHT_FAILED');
    assert.equal(existsSync(lab.results), false);
    assert.equal(existsSync(lab.callsPath), false);
  }
});

test('keeps existing result and staging directories intact', async t => {
  const lab = await fixture(t);
  for (const [relative, id] of [['finished', 'finished'], ['.staging/staged', 'staged']]) {
    const directory = join(lab.results, relative);
    await mkdir(directory, { recursive: true });
    const original = join(directory, 'preflight.json');
    await writeFile(original, 'original evidence');
    const { exit, report } = lab.run(['--arm', 'A', '--preflight-only', '--trial-id', id]);
    assert.equal(exit, 1);
    assert.match(report.reason, /already exists/);
    assert.equal(await readFile(original, 'utf8'), 'original evidence');
  }
  assert.equal(existsSync(lab.callsPath), false);
});

async function installTrialCommands(lab) {
  const tools = join(lab.root, 'tools');
  const drivers = join(tools, 'driver');
  const controllers = join(tools, 'controller');
  await mkdir(drivers);
  await writeFile(join(tools, 'fixture-state.mjs'), `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
export const id = '62621658-5e08-4c66-a028-2516fc6e0a77';
export const mode = process.env.PILOT_TRIAL_MODE;
export const arm = process.env.PILOT_EXPECT_ARM;
export const deployPath = join('deployments', id);
export const configPath = 'runtime/nginx/conf.d/default.conf';
export const statePath = 'deployments/active-deployment.json';
export const timestamp = () => new Date().toISOString();
export function save(file, value) { writeFileSync(file, JSON.stringify(value)); }
export function load(file) { return JSON.parse(readFileSync(file, 'utf8')); }
export async function waitFor(file) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (existsSync(file)) return;
    await sleep(5);
  }
  throw new Error('Timed out waiting for fixture ' + file);
}
`);
  await writeFile(join(controllers, 'promote.mjs'), `
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { id, mode, deployPath, configPath, statePath, save, timestamp } from '../fixture-state.mjs';
if (mode === 'promotion-failed') {
  console.log(JSON.stringify({ status: 'PROMOTION_BLOCKED', reason: 'fixture rejected candidate' }));
  process.exit(2);
}
mkdirSync(deployPath);
const original = readFileSync(configPath, 'utf8');
const candidate = original.replace('app:3000', 'candidate:3000');
writeFileSync(join(deployPath, 'previous-nginx.conf'), original);
writeFileSync(join(deployPath, 'candidate-nginx.conf'), candidate);
writeFileSync(configPath, candidate);
save(statePath, { deployment_id: id, pending_deployment_id: null });
save(join(deployPath, 'deployment.json'), {
  deployment_id: id, status: 'PROMOTED', config_mode: 420, candidate_version: '2.0.0',
  verified_at: timestamp()
});
console.log(JSON.stringify({ status: 'PROMOTED', deployment_id: id }));
`);
  await writeFile(join(controllers, 'monitor.mjs'), `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { id, arm, mode, deployPath, configPath, statePath, load, save, timestamp, waitFor } from '../fixture-state.mjs';
assert.deepEqual(process.argv.slice(2), arm === 'B' ? ['--operator-delay-ms', '10000', id] : [id]);
await waitFor('candidate-fault');
const first = timestamp();
const eventsPath = join('experiments/results/.staging', mode, 'runner-events.jsonl');
while (!readFileSync(eventsPath, 'utf8').includes('"event":"fault_activated"')) {
  await new Promise(resolve => setTimeout(resolve, 5));
}
if (arm === 'B') {
  console.log(JSON.stringify({
    status: 'OPERATOR_DELAY_STARTED', deployment_id: id, confirmed_at: first, first_failure_probe_at: first
  }));
}
if (mode === 'rollback-failed') {
  console.log(JSON.stringify({
    status: 'ROLLBACK_FAILED', deployment_id: id, confirmed_at: first, first_failure_probe_at: first,
    recovery: { started_at: first, failed_step: 'NGINX_RELOAD', proxy_verified: false }
  }));
  writeFileSync('monitor-finished', '');
  process.exit(1);
}
writeFileSync(configPath, readFileSync(join(deployPath, 'previous-nginx.conf')));
save(statePath, { deployment_id: null, pending_deployment_id: null });
const recovery = {
  started_at: first, verified_at: timestamp(), proxy_verified: true,
  verification: { consecutive: 3 }, last_proxy_observation: { http_status: 200, version: '1.0.0' }
};
const path = join(deployPath, 'deployment.json');
save(path, { ...load(path), status: 'RECOVERY_VERIFIED_PENDING_FINALIZATION', rollback: recovery });
console.log(JSON.stringify({
  status: 'ROLLED_BACK', deployment_id: id, confirmed_at: first, first_failure_probe_at: first, recovery
}));
writeFileSync('monitor-finished', '');
`);
  await writeFile(join(drivers, 'driver.js'), `
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mode, save, waitFor } from '../fixture-state.mjs';
const args = process.argv.slice(2);
const trialId = args.at(-1);
assert.deepEqual(args, [
  '--url', 'http://127.0.0.1:8080/api/work', '--rate', '5', '--duration', '60',
  '--warmup', '5', '--timeout', '3000', '--out', resolve('experiments/results'), '--run-id', trialId
]);
const runDir = join('experiments/results', trialId);
assert.equal(existsSync(runDir), false, 'Driver directory was reserved too early');
const start = Date.now();
writeFileSync('driver-ready', '');
await waitFor('monitor-finished');
assert.ok(existsSync('candidate-fault'), 'Fault cleared before driver completed');
writeFileSync('driver-finished', '');
if (mode === 'driver-no-output') {
  console.error('fixture driver failed before producing output');
  process.exit(1);
}
mkdirSync(runDir);
writeFileSync(join(runDir, 'requests.csv'), 'fixture driver rows\\n');
save(join(runDir, 'run.json'), {
  run_id: trialId, status: mode === 'driver-incomplete' ? 'incomplete' : 'complete', wall_start_ms: start,
  summary: { offered: 300 }, invariants: { offered_accounted: true }, review_required: false
});
if (mode === 'driver-incomplete') process.exit(1);
console.log('{"ok":300}');
`);
}

for (const [mode, arm, expected] of [
  ['normal', 'A', 'TRIAL_PASSED'],
  ['rollback-failed', 'B', 'TRIAL_FAILED'],
  ['driver-no-output', 'A', 'TRIAL_FAILED'],
  ['driver-incomplete', 'A', 'TRIAL_FAILED'],
  ['reset-failed', 'A', 'TRIAL_FAILED'],
  ['promotion-failed', 'A', 'TRIAL_FAILED']
]) {
  test('assembles trial evidence for ' + mode, async t => {
    const lab = await fixture(t);
    await installTrialCommands(lab);
    const { exit, report } = lab.run(['--arm', arm, '--trial-id', mode], {
      PILOT_TRIAL_MODE: mode, PILOT_EXPECT_ARM: arm
    });
    assert.equal(report.status, expected, JSON.stringify(report));
    assert.equal(exit, expected === 'TRIAL_PASSED' ? 0 : 1);
    assert.deepEqual(JSON.parse(await readFile(join(report.run_dir, 'trial.json'), 'utf8')), report);
    assert.equal(existsSync(report.staging_dir), false);

    const recorded = (await readFile(join(report.run_dir, 'events.csv'), 'utf8')).trim().split('\n').slice(1)
      .map(line => line.split(','));
    const markers = recorded.map(row => row[2]);
    const times = recorded.map(row => Number(row[3]));
    assert.deepEqual(times, times.toSorted((a, b) => a - b));
    if (mode === 'promotion-failed') {
      assert.equal(markers.includes('driver_spawned'), false);
      assert.equal(existsSync(join(report.run_dir, 'requests.csv')), false);
      assert.equal(existsSync(join(report.run_dir, 'run.json')), false);
      assert.match(await readFile(join(report.run_dir, 'promotion.json'), 'utf8'), /PROMOTION_BLOCKED/);
      return;
    }

    assert.equal(existsSync(join(lab.root, 'candidate-fault')), false);
    assert.equal(report.driver_process.exit_code, mode.startsWith('driver-') ? 1 : 0);
    assert.ok(markers.includes('fault_activation_started'));
    assert.ok(markers.includes('fault_activated'));
    assert.ok(markers.includes('fault_cleared'));
    const controller = (await readFile(join(report.run_dir, 'controller.jsonl'), 'utf8')).trim().split('\n')
      .map(line => JSON.parse(line));
    if (mode === 'driver-no-output') {
      assert.equal(existsSync(join(report.run_dir, 'requests.csv')), false);
      assert.equal(existsSync(join(report.run_dir, 'run.json')), false);
      assert.match(await readFile(join(report.run_dir, 'driver.stderr.log'), 'utf8'), /failed before producing output/);
    } else {
      assert.equal(await readFile(join(report.run_dir, 'requests.csv'), 'utf8'), 'fixture driver rows\n');
      const start = JSON.parse(await readFile(join(report.run_dir, 'run.json'), 'utf8')).wall_start_ms;
      const timestamp = name => times[markers.indexOf(name)];
      assert.deepEqual(report.fault_offset_ms, {
        started: timestamp('fault_activation_started') - start,
        completed: timestamp('fault_activated') - start
      });
      if (mode === 'driver-incomplete') {
        assert.equal(report.driver_status, 'incomplete');
        assert.ok(report.failures.some(item => item.step === 'driver_evidence'));
      }
    }

    const state = JSON.parse(await readFile(lab.statePath, 'utf8'));
    assert.deepEqual(JSON.parse(await readFile(join(report.run_dir, 'active-deployment.json'), 'utf8')), state);
    if (mode === 'rollback-failed') {
      assert.deepEqual(controller.map(event => event.status), ['OPERATOR_DELAY_STARTED', 'ROLLBACK_FAILED']);
      assert.equal(state.deployment_id, report.deployment_id);
      assert.match(await readFile(lab.configPath, 'utf8'), /candidate:3000/);
      assert.ok(report.failures.some(item => item.step === 'reset'));
      assert.equal(markers.filter(marker => marker === 'reset_verified').length, 1);
    } else {
      assert.equal(state.deployment_id, null);
      assert.equal(controller.at(-1).status, 'ROLLED_BACK');
      assert.equal(await readFile(lab.configPath, 'utf8'), stableConfig);
      assert.equal(markers.filter(marker => marker === 'reset_verified').length, mode === 'reset-failed' ? 1 : 2);
      if (mode === 'reset-failed') assert.ok(report.failures.some(item => item.step === 'reset'));
    }
  });
}

test('does not start a second pilot while another process holds the pilot lock', async t => {
  const lab = await fixture(t);
  await mkdir(lab.results, { recursive: true });
  const fd = openSync(join(lab.results, '.pilot.lock'), 'a');
  try {
    const held = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    assert.equal(held.status, 0);
    const { exit, report } = lab.run(['--arm', 'A', '--trial-id', 'busy']);
    assert.equal(exit, 1);
    assert.equal(report.status, 'TRIAL_FAILED');
    assert.deepEqual(report.failures, [{ step: 'trial_lock', reason: 'Another pilot trial is running' }]);
    assert.equal(existsSync(lab.callsPath), false);
    assert.equal(existsSync(join(report.run_dir, 'trial.json')), true);
  } finally {
    closeSync(fd);
  }
});

test('records failed stack checks and preserves routing evidence', async t => {
  const lab = await fixture(t);
  const checks = [
    { id: 'candidate-unhealthy', env: { PILOT_SERVICES: JSON.stringify(
      healthyServices.map(row => row.Service === 'candidate' ? { ...row, Health: 'unhealthy' } : row)
    ) }, reason: /healthy container for candidate/ },
    { id: 'fault-present', env: { PILOT_FAULT: 'present' }, reason: /fault flag must be absent/ },
    { id: 'proxy-candidate', env: { PILOT_PROXY_VERSION: '2.0.0' }, reason: /HTTP 200 from stable/ }
  ];
  for (const { id, env, reason } of checks) {
    const { exit, report } = lab.run(['--arm', 'B', '--preflight-only', '--trial-id', id], env);
    assert.equal(exit, 1);
    assert.equal(report.status, 'PREFLIGHT_FAILED');
    assert.match(report.reason, reason);
    const evidence = JSON.parse(await readFile(join(report.staging_dir, 'preflight.json'), 'utf8'));
    assert.deepEqual(evidence, report);
    assert.equal(existsSync(report.run_dir), false);
  }
  assert.equal(await readFile(lab.configPath, 'utf8'), stableConfig);
  assert.equal(await readFile(lab.statePath, 'utf8'), JSON.stringify(emptyRouting));
});

test('refuses active or pending ownership and a candidate config on disk', async t => {
  const lab = await fixture(t);
  const owner = '4ab1de00-485f-4d05-adeb-8e4c64ccbe63';
  for (const field of ['deployment_id', 'pending_deployment_id']) {
    const routing = JSON.stringify({ ...emptyRouting, [field]: owner });
    await writeFile(lab.statePath, routing);
    const { exit, report } = lab.run(['--arm', 'A', '--preflight-only', '--trial-id', field]);
    assert.equal(exit, 1);
    assert.match(report.reason, /deployment IDs must both be null/);
    assert.equal(await readFile(lab.statePath, 'utf8'), routing);
    assert.equal(existsSync(join(report.staging_dir, 'preflight.json')), true);
  }
  await writeFile(lab.statePath, JSON.stringify(emptyRouting));
  const changedConfig = stableConfig.replace('app:3000', 'candidate:3000');
  await writeFile(lab.configPath, changedConfig);
  const { exit, report } = lab.run(['--arm', 'A', '--preflight-only', '--trial-id', 'candidate-disk']);
  assert.equal(exit, 1);
  assert.match(report.reason, /installed Nginx config must point to stable/);
  assert.equal(await readFile(lab.configPath, 'utf8'), changedConfig);
  assert.equal(existsSync(lab.callsPath), false);
});

test('pilot preflight reports how to initialize a missing runtime config', async t => {
  const lab = await fixture(t);
  await rm(lab.configPath);
  const { exit, report } = lab.run(['--arm', 'A', '--preflight-only']);
  assert.equal(exit, 1);
  assert.equal(report.status, 'PREFLIGHT_FAILED');
  assert.match(report.reason, /init-nginx-runtime\.mjs/);
  assert.equal(existsSync(lab.configPath), false);
  assert.equal(existsSync(lab.callsPath), false);
});
