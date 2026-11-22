import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

const stable = 'location / {\n    proxy_pass http://app:3000;\n}\n';
const candidate = stable.replace('app:3000', 'candidate:3000');

function emulateDocker() {
  const assert = require('node:assert/strict');
  const { appendFileSync, existsSync, readFileSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const args = process.argv.slice(2);
  assert.deepEqual(args.slice(0, 5), ['compose', '--profile', 'routing', 'exec', '-T']);
  appendFileSync('docker-calls.jsonl', JSON.stringify(args.slice(5)) + '\n');

  if (args[5] === 'app') {
    assert.deepEqual(args.slice(5), ['app', 'node', '--input-type=module', '-', '1500', '0']);
    const fakeFetch = [
      "import { appendFileSync, existsSync } from 'node:fs';",
      "globalThis.fetch = async url => {",
      "  const { hostname, pathname } = new URL(url);",
      "  if (hostname !== 'candidate' || !['/health', '/ready'].includes(pathname)) throw Error(url);",
      "  appendFileSync('probe-requests.txt', pathname + '\\n');",
      "  const status = pathname === '/ready' && existsSync('unready') ? 503 : 200;",
      "  return { status, text: async () => '{}' };",
      "};"
    ].join('\n');
    const result = spawnSync(process.execPath, args.slice(7), {
      input: fakeFetch + '\n' + readFileSync(0, 'utf8'), encoding: 'utf8'
    });
    if (result.error) throw result.error;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status);
  }

  assert.deepEqual(args.slice(5, 7), ['nginx', 'nginx']);
  if (args[7] === '-t') {
    assert.deepEqual(args.slice(7), ['-t']);
  } else {
    assert.deepEqual(args.slice(7), ['-s', 'reload']);
    if (existsSync('fail-reload')) {
      console.error('Injected Nginx reload failure');
      process.exitCode = 1;
    }
  }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'conventional-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tools/controller'), { recursive: true });
  mkdirSync(join(root, 'runtime/nginx/conf.d'), { recursive: true });
  mkdirSync(join(root, 'deployments'));
  mkdirSync(join(root, 'bin'));

  for (const file of [
    'conventional-release.mjs', 'deployment-state.mjs', 'nginx-routing.mjs',
    'observe-proxy.mjs', 'probe.mjs'
  ]) {
    copyFileSync(new URL(file, import.meta.url), join(root, 'tools/controller', file));
  }

  const docker = '#!/usr/bin/env node\n(' + emulateDocker.toString() + ')();\n';
  writeFileSync(join(root, 'bin/docker'), docker, { mode: 0o755 });

  const config = join(root, 'runtime/nginx/conf.d/default.conf');
  writeFileSync(config, stable, { mode: 0o640 });

  const statePath = join(root, 'deployments/active-deployment.json');
  writeFileSync(statePath, JSON.stringify({ deployment_id: null, pending_deployment_id: null }));

  return {
    root,
    writeConfig: contents => writeFileSync(config, contents),
    config: () => readFileSync(config, 'utf8'),
    calls: () => {
      const path = join(root, 'docker-calls.jsonl');
      return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) : [];
    },
    state: () => {
      const { deployment_id, pending_deployment_id } = JSON.parse(readFileSync(statePath, 'utf8'));
      return [deployment_id, pending_deployment_id];
    },
    manifest: id => JSON.parse(readFileSync(join(root, 'deployments', id, 'deployment.json'), 'utf8')),
    run(expectedCode, ...args) {
      const result = spawnSync(process.execPath, ['tools/controller/conventional-release.mjs', ...args], {
        cwd: root,
        env: { ...process.env, PATH: join(root, 'bin') + delimiter + process.env.PATH },
        encoding: 'utf8',
        timeout: 15_000
      });
      if (result.error) throw result.error;
      assert.equal(result.status, expectedCode, result.stderr || result.stdout);
      return JSON.parse(result.stdout);
    }
  };
}

test('switches after health-only probes, restores the saved route, and permits the next switch', t => {
  const app = fixture(t);
  const switched = app.run(0, 'switch');
  const id = switched.deployment_id;
  assert.equal(switched.status, 'SWITCHED');
  assert.deepEqual(app.state(), [id, null]);
  assert.equal(app.manifest(id).status, 'CONVENTIONAL_ACTIVE');
  assert.equal(app.config(), candidate);

  assert.equal(app.run(0, 'restore', id).status, 'RESTORED');
  assert.deepEqual(app.state(), [null, null]);
  assert.equal(app.manifest(id).status, 'CONVENTIONAL_RESTORED');
  assert.equal(app.config(), stable);
  assert.equal(readFileSync(join(app.root, 'probe-requests.txt'), 'utf8'), '/health\n/ready\n');
  assert.deepEqual(app.calls().map(args => args[0]), ['app', 'nginx', 'nginx', 'nginx', 'nginx']);
  assert.equal(app.run(0, 'switch').status, 'SWITCHED');
});

test('rejects an unready candidate before changing configuration or claiming the route', t => {
  const app = fixture(t);
  writeFileSync(join(app.root, 'unready'), '');
  const rejected = app.run(1, 'switch');
  assert.equal(rejected.failed_stage, 'check_candidate_health');
  assert.equal(rejected.health[1].http_status, 503);
  assert.equal(app.config(), stable);
  assert.deepEqual(app.state(), [null, null]);
  assert.deepEqual(app.calls().map(args => args[0]), ['app']);
});

test('refuses a second switch, an unrelated restore ID and route drift', t => {
  const app = fixture(t);
  const { deployment_id: id } = app.run(0, 'switch');

  assert.equal(app.run(1, 'switch').failed_stage, 'check_routing_state');
  assert.equal(app.run(1, 'restore', randomUUID()).failed_stage, 'check_route_ownership');
  app.writeConfig(candidate + '# external change\n');
  assert.equal(app.run(1, 'restore', id).failed_stage, 'check_route_ownership');
  assert.equal(app.config(), candidate + '# external change\n');
  assert.deepEqual(app.state(), [id, null]);
  assert.equal(app.calls().length, 3);
});

test('refuses to restore a deployment owned by the health-aware workflow', t => {
  const app = fixture(t);
  const { deployment_id: id } = app.run(0, 'switch');
  const manifest = app.manifest(id);
  delete manifest.workflow;
  manifest.status = 'PROMOTED';
  writeFileSync(join(app.root, 'deployments', id, 'deployment.json'), JSON.stringify(manifest));

  const refused = app.run(1, 'restore', id);
  assert.match(refused.reason, /different workflow/);
  assert.equal(app.config(), candidate);
  assert.deepEqual(app.state(), [id, null]);
  assert.equal(app.calls().length, 3);
});

test('failed reload preserves pending ownership and explicit restore can be retried', t => {
  const app = fixture(t);
  const marker = join(app.root, 'fail-reload');
  writeFileSync(marker, '');

  const failed = app.run(1, 'switch');
  const id = failed.deployment_id;
  assert.equal(failed.failed_stage, 'reload_candidate_route');
  assert.equal(app.config(), candidate);
  assert.deepEqual(app.state(), [null, id]);

  assert.equal(app.run(1, 'restore', id).failed_stage, 'reload_previous_route');
  assert.equal(app.config(), stable);
  assert.deepEqual(app.state(), [null, id]);

  rmSync(marker);
  assert.equal(app.run(0, 'restore', id).status, 'RESTORED');
  assert.deepEqual(app.state(), [null, null]);
  assert.equal(app.config(), stable);
});
