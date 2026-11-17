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
  for (const file of ['deployment-state.mjs', 'monitor.mjs', 'nginx-routing.mjs',
    'observe-proxy.mjs', 'rollback.mjs']) {
    await copyFile(new URL(file, import.meta.url), join(controller, file));
  }
  const routing = await import(pathToFileURL(join(controller, 'deployment-state.mjs')).href);
  const { monitorDeployment } = await import(pathToFileURL(join(controller, 'monitor.mjs')).href);
  const { reconcileRollback, rollbackDeployment } = await import(pathToFileURL(join(controller, 'rollback.mjs')).href);
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
  return {
    routing, monitorDeployment, reconcileRollback, rollbackDeployment,
    configPath, statePath, deploymentId, publish
  };
}

const confirmOnly = () => ({ status: 'DEGRADATION_CONFIRMED' });

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
      recover: confirmOnly,
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
        recover: confirmOnly,
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
      recover: confirmOnly,
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
      recover: () => assert.fail('A attempted rollback after losing ownership'),
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

const stable = { http_status: 200, version: '1.0.0' };
const verified = {
  passed: true, consecutive: 3, last_observation: stable
};
const stages = ['RECORD_ROLLBACK_ATTEMPT', 'CONFIG_WRITE', 'NGINX_CONFIG_TEST',
  'NGINX_RELOAD', 'RECOVERY_VERIFICATION', 'RECORD_VERIFIED_RECOVERY', 'CLEAR_ACTIVE_DEPLOYMENT'];

function recoveryFixture({ routing, deploymentId }, fault) {
  const calls = [];
  function step(name) {
    calls.push(name);
    if (name === fault) throw new Error('Injected ' + name);
  }
  const operations = {
    saveManifest(manifest, updates) {
      if (updates.status === 'ROLLBACK_IN_PROGRESS') step('RECORD_ROLLBACK_ATTEMPT');
      if (updates.status === 'RECOVERY_VERIFIED_PENDING_FINALIZATION') step('RECORD_VERIFIED_RECOVERY');
      return routing.writeDeployment(manifest, updates);
    },
    installConfig(...args) {
      assert.equal(routing.readDeploymentManifest(deploymentId).status, 'ROLLBACK_IN_PROGRESS');
      step('CONFIG_WRITE');
      routing.writeAtomic(...args);
    },
    runNginx(...args) {
      if (args[0] === '-s') assert.deepEqual(args, ['-s', 'reload']);
      step(args[0] === '-t' ? 'NGINX_CONFIG_TEST' : 'NGINX_RELOAD');
    },
    async verify(version) {
      assert.equal(version, '1.0.0');
      assert.equal(routing.readRoutingState().deployment_id, deploymentId);
      await assert.rejects(routing.withRoutingLock(() => {}), routing.RoutingLockBusyError);
      calls.push('RECOVERY_VERIFICATION');
      return fault === 'RECOVERY_VERIFICATION'
        ? { passed: false, consecutive: 0, last_observation: healthy }
        : verified;
    },
    saveRoutingState(...args) {
      assert.equal(routing.readDeploymentManifest(deploymentId).status,
        'RECOVERY_VERIFIED_PENDING_FINALIZATION');
      assert.equal(routing.readRoutingState().deployment_id, deploymentId);
      step('CLEAR_ACTIVE_DEPLOYMENT');
      routing.writeRoutingState(...args);
    }
  };
  return { calls, operations };
}

describe('locked rollback', { concurrency: true, timeout: 15000 }, () => {
  test('does not request operator action while another monitor is finalizing', async t => {
    const { routing, deploymentId, monitorDeployment } = await fixture(t);
    const ready = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const holder = routing.withRoutingLock(async () => {
      let manifest = routing.readDeploymentManifest(deploymentId);
      manifest = routing.writeDeployment(manifest, { status: 'ROLLBACK_IN_PROGRESS' });
      ready.resolve();
      await finish.promise;
      routing.writeDeployment(manifest, { status: 'RECOVERY_VERIFIED_PENDING_FINALIZATION' });
      routing.writeRoutingState(null, null);
    });
    await ready.promise;

    const events = [];
    try {
      const status = await monitorDeployment(deploymentId, {
        observe: () => assert.fail('The completed deployment should no longer be probed'),
        async lockRouting(action) {
          try {
            return await routing.withRoutingLock(action);
          } catch (error) {
            finish.resolve();
            await holder;
            throw error;
          }
        },
        report: event => events.push(event.status)
      });
      assert.equal(status, 'LOST_OWNERSHIP');
      assert.deepEqual(events, ['LOST_OWNERSHIP']);
    } finally {
      finish.resolve();
      await holder;
    }
  });

  test('confirms and restores under one lock, then clears active ownership', async t => {
    const lab = await fixture(t);
    const { routing, deploymentId, configPath, monitorDeployment, rollbackDeployment } = lab;
    const { calls, operations } = recoveryFixture(lab);
    const events = [];
    const result = await monitorDeployment(deploymentId, {
      observe: async () => failed,
      recover: (deployment, observation) => rollbackDeployment(deployment, observation, operations),
      report: event => events.push(event)
    });
    assert.equal(result, 'ROLLED_BACK');
    assert.equal(events[0].consecutive_failures, 3);
    assert.deepEqual(events[0].confirmation, failed);
    assert.equal(events[0].recovery.verification.consecutive, 3);
    assert.deepEqual(events[0].recovery.last_proxy_observation, stable);
    assert.deepEqual(calls, stages);
    assert.deepEqual(await readFile(configPath), previousConfig);
    assert.equal(routing.readRoutingState().deployment_id, null);
  });

  for (const [index, fault] of stages.entries()) {
    test(`retains ownership on ${fault}`, async t => {
      const lab = await fixture(t);
      const { routing, rollbackDeployment, configPath, deploymentId } = lab;
      const { calls, operations } = recoveryFixture(lab, fault);
      const result = await routing.withRoutingLock(() =>
        rollbackDeployment(routing.readDeployment(deploymentId), failed, operations));

      assert.equal(result.status, index >= 5 ? 'FINALIZATION_FAILED' : 'ROLLBACK_FAILED');
      assert.equal(result.recovery.failed_step, fault);
      assert.equal(result.recovery.config_installed, index >= 2);
      assert.equal(result.recovery.proxy_verified, index >= 5);
      assert.deepEqual(result.recovery.last_proxy_observation,
        index >= 5 ? stable : index === 4 ? healthy : failed);
      assert.equal(routing.readRoutingState().deployment_id, deploymentId);
      assert.deepEqual(calls, stages.slice(0, index + 1));
      assert.deepEqual(await readFile(configPath), index >= 2 ? previousConfig : candidateConfig);
      const { manifest, previous, candidate } = routing.readDeployment(deploymentId);
      assert.deepEqual(previous, previousConfig);
      assert.deepEqual(candidate, candidateConfig);
      if (index === 0) assert.equal(manifest.status, 'PROMOTED');
      else {
        assert.equal(manifest.status, index === 6
          ? 'RECOVERY_VERIFIED_PENDING_FINALIZATION' : 'ROLLBACK_IN_PROGRESS');
        assert.equal(manifest.rollback.failed_step, fault);
      }
    });
  }

  for (const fault of ['NGINX_RELOAD', 'CLEAR_ACTIVE_DEPLOYMENT']) {
    test(`requires operator reconciliation after ${fault}`, async t => {
      const lab = await fixture(t);
      const { routing, rollbackDeployment, reconcileRollback, monitorDeployment,
        configPath, deploymentId } = lab;
      await routing.withRoutingLock(() =>
        rollbackDeployment(routing.readDeployment(deploymentId), failed, recoveryFixture(lab, fault).operations));

      const events = [];
      assert.equal(await monitorDeployment(deploymentId, {
        observe: () => assert.fail('Ordinary monitor tried to probe an unresolved rollback'),
        report: event => events.push(event)
      }), 'RECONCILIATION_REQUIRED');
      assert.equal(events[0].status, 'RECONCILIATION_REQUIRED');

      const unrelated = Buffer.from('# unrelated config edit');
      await writeFile(configPath, unrelated);
      const refused = await reconcileRollback(deploymentId, () => assert.fail('Reconciliation used unrelated config'));
      assert.equal(refused.status, 'RECONCILIATION_REFUSED');
      assert.deepEqual(await readFile(configPath), unrelated);
      await writeFile(configPath, previousConfig);

      const { calls, operations } = recoveryFixture(lab);
      const retried = await reconcileRollback(deploymentId,
        (deployment, observation) => rollbackDeployment(deployment, observation, operations));
      assert.equal(retried.status, 'ROLLED_BACK');
      assert.deepEqual(calls, stages.filter(item => item !== 'CONFIG_WRITE'));
      assert.equal(routing.readRoutingState().deployment_id, null);
    });
  }
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
