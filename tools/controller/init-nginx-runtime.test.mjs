import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const templateBytes = Buffer.from('server { location / { proxy_pass http://app:3000; } }\n');
const otherBytes = Buffer.from('server { location / { proxy_pass http://candidate:3000; } }\n');
const deploymentId = '3936d450-fc98-473f-9e49-4843d959a26c';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'nginx-runtime-init-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const controller = join(root, 'tools/controller');
  const template = join(root, 'infra/nginx/conf.d/default.conf');
  const config = join(root, 'runtime/nginx/conf.d/default.conf');
  const state = join(root, 'deployments/active-deployment.json');
  mkdirSync(controller, { recursive: true });
  mkdirSync(dirname(template), { recursive: true });
  writeFileSync(template, templateBytes);
  for (const file of ['init-nginx-runtime.mjs', 'deployment-state.mjs', 'nginx-routing.mjs',
    'observe-proxy.mjs', 'promote.mjs']) {
    copyFileSync(new URL(file, import.meta.url), join(controller, file));
  }
  function run(file = 'init-nginx-runtime.mjs', options = []) {
    const result = spawnSync(process.execPath, [...options, join(controller, file)], {
      cwd: root, encoding: 'utf8', timeout: 5000
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    return result;
  }
  function writeState(contents) {
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, contents);
  }
  return { root, config, template, state, run, writeState };
}

test('initializes from the tracked template and preserves an existing runtime file', t => {
  const lab = fixture(t);
  assert.equal(existsSync(dirname(lab.state)), false);
  const first = lab.run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'initialized');
  assert.deepEqual(readFileSync(lab.config), templateBytes);
  assert.deepEqual(readFileSync(lab.template), templateBytes);
  assert.equal(statSync(lab.config).mode & 0o777, 0o644);
  assert.equal(existsSync(lab.state), false);
  assert.equal(existsSync(join(dirname(lab.state), 'routing.lock')), true);

  writeFileSync(lab.config, otherBytes);
  lab.writeState(JSON.stringify({ deployment_id: deploymentId, pending_deployment_id: null }));
  const inode = statSync(lab.config).ino;
  const next = lab.run();
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).status, 'preserved');
  assert.deepEqual(readFileSync(lab.config), otherBytes);
  assert.equal(statSync(lab.config).ino, inode);
  assert.deepEqual(readdirSync(dirname(lab.config)), ['default.conf']);
});

for (const field of ['deployment_id', 'pending_deployment_id']) {
  test('refuses to seed an absent runtime file when ' + field + ' is set', t => {
    const lab = fixture(t);
    const state = JSON.stringify({
      deployment_id: null, pending_deployment_id: null, [field]: deploymentId
    });
    lab.writeState(state);
    const result = lab.run();
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr).reason, /Both deployment IDs must be clear/);
    assert.equal(existsSync(dirname(lab.config)), false);
    assert.equal(readFileSync(lab.state, 'utf8'), state);
  });
}

test('refuses malformed state and a missing template before creating the runtime directory', t => {
  const lab = fixture(t);
  lab.writeState('{}');
  const malformed = lab.run();
  assert.equal(malformed.status, 1);
  assert.match(JSON.parse(malformed.stderr).reason, /Invalid active-deployment record/);
  assert.equal(existsSync(dirname(lab.config)), false);

  lab.writeState(JSON.stringify({ deployment_id: null, pending_deployment_id: null }));
  rmSync(lab.template);
  const missing = lab.run();
  assert.equal(missing.status, 1);
  assert.match(JSON.parse(missing.stderr).reason, /ENOENT/);
  assert.equal(existsSync(dirname(lab.config)), false);
});

for (const kind of ['symlink', 'directory']) {
  test('preserves an unexpected ' + kind + ' at the destination and reports failure', t => {
    const lab = fixture(t);
    mkdirSync(dirname(lab.config), { recursive: true });
    if (kind === 'symlink') symlinkSync(lab.template, lab.config);
    else mkdirSync(lab.config);
    const result = lab.run();
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr).reason, /regular file/);
    assert.equal(lstatSync(lab.config)[kind === 'symlink' ? 'isSymbolicLink' : 'isDirectory'](), true);
    assert.deepEqual(readFileSync(lab.template), templateBytes);
  });
}

test('publishes a complete seed without clobbering a file created during publication', t => {
  const lab = fixture(t);
  const preload = join(lab.root, 'race.mjs');
  writeFileSync(preload, `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const link = fs.linkSync;
fs.linkSync = (temporary, destination) => {
  assert.match(temporary, /\\.tmp$/);
  assert.deepEqual(fs.readFileSync(temporary), Buffer.from(${JSON.stringify([...templateBytes])}));
  fs.writeFileSync(destination, Buffer.from(${JSON.stringify([...otherBytes])}), { flag: 'wx' });
  return link(temporary, destination);
};
syncBuiltinESMExports();
`);
  const result = lab.run('init-nginx-runtime.mjs', ['--import', preload]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'preserved');
  assert.deepEqual(readFileSync(lab.config), otherBytes);
  assert.deepEqual(readdirSync(dirname(lab.config)), ['default.conf']);
});

for (const method of ['writeFileSync', 'linkSync']) {
  test('removes the temporary file after a failed ' + method, t => {
    const lab = fixture(t);
    const preload = join(lab.root, 'failure.mjs');
    writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const original = fs.${method};
fs.${method} = (target, ...args) => {
  if (typeof target === 'number') original(target, Buffer.from('partial'));
  throw Object.assign(new Error('Injected publication failure'), { code: 'ENOSPC' });
};
syncBuiltinESMExports();
`);
    const result = lab.run('init-nginx-runtime.mjs', ['--import', preload]);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stderr).reason, /Injected publication failure/);
    assert.equal(existsSync(lab.config), false);
    assert.deepEqual(readdirSync(dirname(lab.config)), []);
  });
}

test('respects the routing lock and initializes once the owner releases it', t => {
  const lab = fixture(t);
  mkdirSync(dirname(lab.state));
  const fd = openSync(join(dirname(lab.state), 'routing.lock'), 'a');
  try {
    const lock = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd] });
    assert.equal(lock.status, 0, lock.stderr?.toString());
    const busy = lab.run();
    assert.equal(busy.status, 1);
    assert.match(JSON.parse(busy.stderr).reason, /Routing lock is held/);
    assert.equal(existsSync(lab.config), false);
  } finally {
    closeSync(fd);
  }
  assert.equal(JSON.parse(lab.run().stdout).status, 'initialized');
  assert.equal(JSON.parse(lab.run().stdout).status, 'preserved');
});

test('a promotion with no runtime file tells the operator how to initialize', t => {
  const lab = fixture(t);
  const result = lab.run('promote.mjs');
  assert.equal(result.status, 1);
  const event = JSON.parse(result.stdout);
  assert.equal(event.status, 'PROMOTION_FAILED');
  assert.equal(event.failed_stage, 'check_saved_config');
  assert.match(event.reason, /init-nginx-runtime\.mjs/);
  assert.equal(existsSync(lab.config), false);
});
