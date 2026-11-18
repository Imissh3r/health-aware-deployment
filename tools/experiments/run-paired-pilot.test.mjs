import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  const config = join(root, 'infra/nginx/conf.d');
  const deployments = join(root, 'deployments');
  for (const directory of [controllers, experiments, bin, config, deployments]) {
    await mkdir(directory, { recursive: true });
  }
  for (const name of ['deployment-state.mjs', 'nginx-routing.mjs', 'observe-proxy.mjs']) {
    await copyFile(new URL('../controller/' + name, import.meta.url), join(controllers, name));
  }
  const cli = join(experiments, 'run-paired-pilot.mjs');
  await copyFile(new URL('./run-paired-pilot.mjs', import.meta.url), cli);
  const configPath = join(config, 'default.conf');
  const statePath = join(deployments, 'active-deployment.json');
  const callsPath = join(root, 'compose-calls');
  const results = join(root, 'experiments/results');
  const preload = join(root, 'proxy.mjs');
  await writeFile(configPath, stableConfig);
  await writeFile(statePath, JSON.stringify(emptyRouting));
  await writeFile(preload, `
globalThis.fetch = async url => {
  if (url !== 'http://127.0.0.1:8080/api/work') throw new Error('Unexpected proxy URL');
  return new Response(JSON.stringify({ version: process.env.PILOT_PROXY_VERSION }), { status: 200 });
};
`);
  await writeFile(join(bin, 'docker'), `#!/usr/bin/env node
const assert = require('node:assert/strict');
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
assert.deepEqual(args.slice(0, 3), ['compose', '--profile', 'routing']);
const command = args.slice(3);
appendFileSync(process.env.PILOT_COMPOSE_CALLS, JSON.stringify(command) + '\\n');
if (command[0] === 'ps') {
  assert.deepEqual(command, ${JSON.stringify(psArgs)});
  const rows = JSON.parse(process.env.PILOT_SERVICES);
  console.log(process.env.PILOT_LIST_FORMAT === 'array' ? JSON.stringify(rows) : rows.map(row => JSON.stringify(row)).join('\\n'));
} else {
  assert.deepEqual(command, ['exec', '-T', 'candidate', 'sh', '-c',
    'if test -e "$1"; then printf present; else printf absent; fi',
    'sh', '/tmp/health-aware-workload-fault']);
  console.log(process.env.PILOT_FAULT);
}
`, { mode: 0o700 });

  function run(args, env = {}) {
    const result = spawnSync(process.execPath, ['--import', preload, cli, ...args], {
      cwd: bin,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        PATH: bin + delimiter + process.env.PATH,
        PILOT_COMPOSE_CALLS: callsPath,
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
  return { run, results, callsPath, configPath, statePath };
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

test('rejects unsupported arms, unsafe IDs, duplicate options, and full-run invocations before staging', async t => {
  const lab = await fixture(t);
  for (const args of [
    ['--arm', 'C', '--preflight-only'],
    ['--arm', 'A', '--preflight-only', '--trial-id', '../../outside'],
    ['--arm', 'A', '--arm', 'B', '--preflight-only'],
    ['--arm', 'A']
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
