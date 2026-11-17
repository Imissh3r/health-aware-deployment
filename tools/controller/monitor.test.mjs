import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { observeProxy } from './observe-proxy.mjs';

const healthy = { http_status: 200, version: '2.0.0' };
const failed = { http_status: 500, version: '2.0.0' };
const previousConfig = Buffer.from('location / { proxy_pass http://app:3000; }\n');
const candidateConfig = Buffer.from('location / { proxy_pass http://candidate:3000; }\n');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'deployment-monitor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const controller = join(root, 'tools', 'controller');
  const configDir = join(root, 'infra', 'nginx', 'conf.d');
  await Promise.all([controller, configDir].map(path => mkdir(path, { recursive: true })));
  for (const file of ['deployment-state.mjs', 'monitor.mjs', 'observe-proxy.mjs']) {
    await copyFile(new URL(file, import.meta.url), join(controller, file));
  }
  const routing = await import(pathToFileURL(join(controller, 'deployment-state.mjs')).href);
  const { monitorDeployment } = await import(pathToFileURL(join(controller, 'monitor.mjs')).href);
  const configPath = join(configDir, 'default.conf');
  const statePath = join(routing.deploymentsPath, 'active-deployment.json');
  await writeFile(configPath, candidateConfig);

  function publish() {
    return routing.withRoutingLock(() => {
      const deployment = routing.prepareDeployment(previousConfig, candidateConfig, 0o644, '1.0.0', '2.0.0');
      const manifest = routing.writeDeployment(deployment, { status: 'PROMOTED' });
      routing.writeRoutingState(manifest.deployment_id, null);
      return manifest.deployment_id;
    });
  }
  const deploymentId = await publish();
  return { routing, monitorDeployment, configPath, statePath, deploymentId, publish };
}

describe('runtime monitor', { concurrency: true, timeout: 15000 }, () => {
  test('confirms persistent degradation while holding the routing lock', async t => {
    const { routing, monitorDeployment, statePath, deploymentId } = await fixture(t);
    const stateBefore = await readFile(statePath);
    let probes = 0;
    const events = [];

    const result = await monitorDeployment(deploymentId, {
      async observe() {
        probes++;
        if (probes === 4) {
          await assert.rejects(routing.withRoutingLock(() => {}), routing.RoutingLockBusyError);
        }
        return failed;
      },
      report: event => events.push(event)
    });
    assert.equal(result, 'DEGRADATION_CONFIRMED');
    assert.equal(probes, 4);
    assert.equal(events[0].consecutive_failures, 3);
    assert.deepEqual(events[0].confirmation, failed);
    assert.deepEqual(await readFile(statePath), stateBefore);
  });

  test('keeps probing during contention and drops the old streak on recovery', async t => {
    const { routing, monitorDeployment, deploymentId } = await fixture(t);
    const ready = Promise.withResolvers();
    const release = Promise.withResolvers();
    const holder = routing.withRoutingLock(async () => {
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    let probes = 0;
    const events = [];
    try {
      const result = await monitorDeployment(deploymentId, {
        async observe() {
          probes++;
          if (probes === 4) {
            release.resolve();
            await holder;
            return healthy;
          }
          assert.ok(probes <= 8);
          return failed;
        },
        report: event => events.push([event.status, probes])
      });
      assert.equal(result, 'DEGRADATION_CONFIRMED');
      assert.deepEqual(events, [['LOCK_BUSY', 3], ['DEGRADATION_CONFIRMED', 8]]);
    } finally {
      release.resolve();
      await holder;
    }
  });

  test('a recovered confirmation clears the streak and monitoring resumes', async t => {
    const { monitorDeployment, deploymentId } = await fixture(t);
    const observations = [failed, failed, failed, healthy, failed, failed, failed, failed];
    const events = [];
    const result = await monitorDeployment(deploymentId, {
      async observe() {
        assert.ok(observations.length > 0);
        return observations.shift();
      },
      report: event => events.push([event.status, event.confirmation])
    });
    assert.equal(result, 'DEGRADATION_CONFIRMED');
    assert.equal(observations.length, 0);
    assert.deepEqual(events, [['DEGRADATION_CLEARED', healthy], ['DEGRADATION_CONFIRMED', failed]]);
  });

  test('A loses ownership to B before lock acquisition even when config and version match', async t => {
    const { routing, monitorDeployment, configPath, statePath, deploymentId, publish } = await fixture(t);
    const beforeLock = Promise.withResolvers();
    const resume = Promise.withResolvers();
    let probes = 0;
    const events = [];
    const monitor = monitorDeployment(deploymentId, {
      async observe() {
        assert.ok(++probes <= 3, 'A issued a confirmation probe after losing ownership');
        return failed;
      },
      async lockRouting(action) {
        beforeLock.resolve();
        await resume.promise;
        return routing.withRoutingLock(action);
      },
      report: event => events.push(event)
    });
    let idB;
    let paths;
    let before;
    try {
      await beforeLock.promise;
      idB = await publish();
      assert.notEqual(idB, deploymentId);
      const a = routing.readDeployment(deploymentId);
      const b = routing.readDeployment(idB);
      assert.deepEqual(a.candidate, b.candidate);
      assert.equal(a.manifest.candidate_version, b.manifest.candidate_version);
      paths = [statePath, configPath, join(routing.deploymentsPath, idB, 'deployment.json')];
      before = await Promise.all(paths.map(path => readFile(path)));
    } finally {
      resume.resolve();
    }

    assert.equal(await monitor, 'LOST_OWNERSHIP');
    assert.equal(probes, 3);
    assert.equal(events[0].status, 'LOST_OWNERSHIP');
    assert.equal(events[0].active_deployment_id, idB);
    assert.equal(routing.readRoutingState().deployment_id, idB);
    assert.equal(routing.readDeployment(idB).manifest.status, 'PROMOTED');
    assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
  });
});

test('proxy probe times out while reading a stalled HTTP 500 body', { timeout: 5000 }, async t => {
  const server = createServer((request, response) => {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.write('{"version":');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/api/work';
  const observation = await observeProxy(500, { url, versionStatuses: [500] });
  assert.equal(observation.http_status, 500);
  assert.equal(observation.version, null);
  assert.match(observation.error, /abort|timed out/i);
});
