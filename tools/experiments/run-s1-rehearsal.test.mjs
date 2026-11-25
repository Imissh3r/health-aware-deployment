import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { launchS1Rehearsal, observeRehearsalEnvironment } from './run-s1-rehearsal.mjs';

const project = 'health-aware-workflow-comparison';
const network = project + '_default';
const volume = project + '_db-data';
const volumePath = '/var/lib/docker/volumes/' + volume + '/_data';
const gitRevision = 'a'.repeat(40);
const secret = 'test-only-secret-that-must-not-appear';
const ids = ['app', 'candidate', 'db', 'nginx'];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 's1-launcher-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['experiments/results', 'runtime/nginx/conf.d', 'infra/nginx/conf.d', 'deployments']) {
    await mkdir(join(root, folder), { recursive: true });
  }
  for (const folder of ['runtime', 'infra']) await writeFile(join(root, folder, 'nginx/conf.d/default.conf'), 'fixture stable config');
  await writeFile(join(root, 'deployments/active-deployment.json'), '{"deployment_id":null,"pending_deployment_id":null}');
  const env = { COMPOSE_PROJECT_NAME: project, DEPLOYMENT_PROXY_URL: 'http://127.0.0.1:18080/api/work',
    COMPOSE_FILE: join(root, 'compose.yaml') + ':' + join(root, 'compose.comparison.yaml') };
  const app = { build: { context: join(root, 'apps/sample-app') }, depends_on: { db: { condition: 'service_healthy', required: true } },
    environment: { APP_VERSION: '1.0.0', PGHOST: 'db', PGPORT: '5432', PGUSER: secret, PGPASSWORD: secret,
      PGDATABASE: secret, ERROR_EVERY_N_REQUESTS: '0', RESPONSE_DELAY_MS: '0' }, networks: { default: null } };
  const binding = (published, target) => ({ host_ip: '127.0.0.1', published, target, protocol: 'tcp' });
  const model = { name: project, networks: { default: { name: network } }, volumes: { 'db-data': { name: volume } },
    services: {
      app: { ...app, ports: [binding('13000', 3000)] },
      candidate: { ...app, profiles: ['routing'], environment: { ...app.environment, APP_VERSION: '2.0.0',
        WORKLOAD_FAULT_FILE: '/tmp/health-aware-workload-fault' } },
      db: { image: 'postgres:17', networks: { default: null },
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}'],
          interval: '5s', timeout: '3s', retries: 5, start_period: '10s' },
        environment: { POSTGRES_USER: secret, POSTGRES_PASSWORD: secret, POSTGRES_DB: secret },
        volumes: [{ type: 'volume', source: 'db-data', target: '/var/lib/postgresql/data' }] },
      nginx: { image: 'nginx:stable-alpine', profiles: ['routing'], networks: { default: null },
        depends_on: { app: { condition: 'service_healthy', required: true } },
        ports: [binding('18080', 80)], volumes: [{ type: 'bind', source: join(root, 'runtime/nginx/conf.d'),
          target: '/etc/nginx/conf.d', read_only: true, bind: { create_host_path: false } }] }
    }
  };
  const containers = ids.map((service, index) => {
    const spec = model.services[service];
    return { Id: String(index + 1).repeat(64), Image: 'sha256:' + String(index + 1).repeat(64),
      State: { Running: true, Health: { Status: 'healthy' } },
      Config: { Labels: { 'com.docker.compose.project': project, 'com.docker.compose.service': service },
        Env: Object.entries(spec.environment ?? {}).map(([key, value]) => key + '=' + value) },
      NetworkSettings: { Networks: { [network]: { NetworkID: 'f'.repeat(64) } },
        Ports: Object.fromEntries((spec.ports ?? []).map(port =>
          [port.target + '/tcp', [{ HostIp: port.host_ip, HostPort: port.published }]])) },
      Mounts: (spec.volumes ?? []).map(mount => ({ Type: mount.type, Name: volume,
        Source: mount.type === 'volume' ? volumePath : mount.source, Destination: mount.target, RW: !mount.read_only }))
    };
  });
  const meta = { gitRevision, dirty: false, model, containers };
  const calls = [];
  const command = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'flock') return 'flock from util-linux 2.39.3';
    if (args[0] === 'version' || args[1] === 'version') return '29.9.3';
    if (file === 'git') return { 'rev-parse': meta.gitRevision, branch: 'workflow-comparison', status: meta.dirty ? '?? dirty' : '' }[args[0]];
    if (args[0] === 'compose' && args.includes('config')) return JSON.stringify(meta.model);
    if (args[0] === 'compose' && args.includes('port')) return '127.0.0.1:18080';
    if (args[0] === 'ps') return meta.containers.map(container => container.Id).join('\n');
    if (args[0] === 'container') return JSON.stringify(meta.containers);
    if (args[0] === 'network') return JSON.stringify([{ Id: 'f'.repeat(64), Name: network, Driver: 'bridge',
      Labels: { 'com.docker.compose.project': project } }]);
    if (args[0] === 'volume') return JSON.stringify([{ Name: volume, Driver: 'local', Mountpoint: volumePath, CreatedAt: '2026-11-25T00:00:00Z',
      Labels: { 'com.docker.compose.project': project, 'com.docker.compose.volume': 'db-data' } }]);
    if (args[0] === 'image') {
      const index = [project + '-app', project + '-candidate', 'postgres:17', 'nginx:stable-alpine'].indexOf(args[2]);
      return JSON.stringify([{ Id: meta.containers[index].Image }]);
    }
    throw new Error('Unexpected fixture operation');
  };
  const observe = () => observeRehearsalEnvironment({ root, env, host: 'fixture', kernel: '6.18-microsoft-WSL2', command });
  const request = { action: 'check', sessionId: 'fixture-s1', gitRevision };
  return { root, observe, meta, calls, request };
}

test('check is read-only and generates only the isolated S1 H assignment and reproducible provenance', async t => {
  const f = await fixture(t);
  const prohibited = () => assert.fail('Experiment operation during check');
  const options = { ...f, initialize: prohibited, open: prohibited };
  const first = await launchS1Rehearsal(f.request, options);
  f.meta.model.services = Object.fromEntries(Object.entries(f.meta.model.services).reverse());
  assert.deepEqual(await launchS1Rehearsal(f.request, options), first);
  assert.match(first.directory, /experiments\/results\/rehearsal-fixture-s1$/);
  assert.equal(first.manifest.purpose, 'rehearsal');
  assert.deepEqual(first.manifest.arms.map(({ scenario, arm }) => [scenario, arm]), [['S1', 'H']]);
  assert.equal(first.manifest.arms[0].trialId, 'rehearsal-fixture-s1-1-S1-H');
  assert.ok(!JSON.stringify(first).includes(secret));
  assert.deepEqual(await readdir(join(f.root, 'experiments/results')), []);
  assert.ok(!f.calls.some(args => args.includes('exec') || args.includes('up')));
});

test('execute requires explicit authorization and rejects changed images, Compose or source before initialization', async t => {
  const f = await fixture(t);
  const preflight = await launchS1Rehearsal(f.request, f);
  const execute = { ...f.request, action: 'execute', fingerprint: preflight.manifest.frozen.environmentFingerprint };
  const never = { ...f, initialize: () => assert.fail('Invalid preflight initialized a session') };
  await assert.rejects(launchS1Rehearsal(execute, never), /authorization|authorize/);
  execute.authorizeS1H = true;
  f.meta.containers[0].Image = 'sha256:' + 'e'.repeat(64);
  await assert.rejects(launchS1Rehearsal(execute, never), /reviewed check fingerprint/);
  f.meta.containers[0].Image = 'sha256:' + '1'.repeat(64);
  f.meta.model.services.app.ports[0].published = '9999';
  await assert.rejects(launchS1Rehearsal(execute, never), /Unexpected published ports/);
  f.meta.model.services.app.ports[0].published = '13000';
  f.meta.dirty = true;
  await assert.rejects(launchS1Rehearsal(execute, never), /clean/);
  f.meta.dirty = false;
  f.meta.gitRevision = 'b'.repeat(40);
  await assert.rejects(launchS1Rehearsal(execute, never), /expected revision/);
  f.meta.gitRevision = gitRevision;
  delete f.meta.model.services.app.environment.PGPASSWORD;
  await assert.rejects(launchS1Rehearsal(execute, never), /Missing database environment/);
  assert.deepEqual(await readdir(join(f.root, 'experiments/results')), []);
});

test('execution uses a fresh verifier, preserves provenance and calls the coordinator exactly once', async t => {
  const f = await fixture(t);
  const preflight = await launchS1Rehearsal(f.request, f);
  let calls = 0;
  const result = await launchS1Rehearsal({ ...f.request, action: 'execute', authorizeS1H: true,
    fingerprint: preflight.manifest.frozen.environmentFingerprint }, {
    ...f,
    open(directory, { expectedMode, verifyEnvironment }) {
      assert.equal(expectedMode, 'rehearsal');
      return {
        async runNext() {
          calls++;
          const { manifest, mode } = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
          assert.equal(mode, 'rehearsal');
          const expected = { gitRevision, frozen: manifest.frozen };
          assert.deepEqual(await verifyEnvironment(expected), expected);
          f.meta.containers[0].Image = 'sha256:' + 'e'.repeat(64);
          await assert.rejects(verifyEnvironment(expected), /Environment changed/);
          return { type: 'outcome' };
        },
        inspect: () => ({ status: 'reset_blocked' })
      };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'reset_blocked');
  for (const file of ['comparison-compose.redacted.json', 'rehearsal-preflight.json', 'manifest.json']) {
    assert.ok(!(await readFile(join(result.directory, file), 'utf8')).includes(secret));
  }
  await assert.rejects(launchS1Rehearsal(f.request, f), /already exists/);
});

test('launcher preserves the coordinator interruption result without retrying', async t => {
  const f = await fixture(t);
  const preflight = await launchS1Rehearsal(f.request, f);
  let attempts = 0;
  const outcome = await launchS1Rehearsal({ ...f.request, action: 'execute', authorizeS1H: true,
    fingerprint: preflight.manifest.frozen.environmentFingerprint }, {
    ...f, open: () => ({
      runNext: async () => { attempts++; return { type: 'interrupted' }; },
      inspect: () => ({ status: 'interrupted_or_unresolved' })
    })
  });
  assert.equal(attempts, 1);
  assert.equal(outcome.status, 'interrupted_or_unresolved');
});
