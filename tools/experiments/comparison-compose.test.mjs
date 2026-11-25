import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));

test('comparison Compose model resolves offline with isolated names and only the comparison ports', async () => {
  const compose = async files => {
    const { stdout } = await run('docker', ['compose', '--env-file', '/dev/null', ...files.flatMap(file => ['-f', file]),
      '--profile', 'routing', 'config', '--format', 'json'], {
      cwd: repo,
      env: { PATH: process.env.PATH, DOCKER_HOST: 'unix:///dev/null', POSTGRES_USER: 'fixture',
        POSTGRES_PASSWORD: 'fixture', POSTGRES_DB: 'fixture' }
    });
    return JSON.parse(stdout);
  };

  const baseline = await compose(['compose.yaml']);
  const comparison = await compose(['compose.yaml', 'compose.comparison.yaml']);
  const { app, nginx, candidate, db } = comparison.services;
  assert.equal(comparison.name, 'health-aware-workflow-comparison');
  assert.equal(comparison.volumes['db-data'].name, 'health-aware-workflow-comparison_db-data');
  assert.equal(comparison.networks.default.name, 'health-aware-workflow-comparison_default');
  const ports = service => service.ports.map(({ host_ip, published, target }) => [host_ip, published, target]);
  assert.deepEqual(ports(app), [['127.0.0.1', '13000', 3000]]);
  assert.deepEqual(ports(nginx), [['127.0.0.1', '18080', 80]]);
  assert.deepEqual(candidate, baseline.services.candidate);
  assert.deepEqual(db, baseline.services.db);
  assert.equal(candidate.ports, undefined);
  assert.equal(db.ports, undefined);
  assert.equal(app.environment.APP_VERSION, '1.0.0');
  assert.equal(candidate.environment.APP_VERSION, '2.0.0');
  assert.equal(candidate.environment.WORKLOAD_FAULT_FILE, '/tmp/health-aware-workload-fault');
  assert.equal(candidate.depends_on.db.condition, 'service_healthy');
  assert.equal(app.depends_on.db.condition, 'service_healthy');
  assert.equal(nginx.depends_on.app.condition, 'service_healthy');
  assert.deepEqual(nginx.volumes, baseline.services.nginx.volumes);
  assert.equal(nginx.volumes[0].read_only, true);
  assert.equal(db.volumes[0].source, 'db-data');
  assert.deepEqual(ports(baseline.services.app), [['127.0.0.1', '3000', 3000]]);
  assert.deepEqual(ports(baseline.services.nginx), [['127.0.0.1', '8080', 80]]);
});
