import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import {
  prepareDeployment, readDeployment, readRoutingState, withRoutingLock,
  writeAtomic, writeDeployment, writeRoutingState
} from './deployment-state.mjs';
import { configPath, nginx, readRuntimeConfig } from './nginx-routing.mjs';

const repoRoot = new URL('../../', import.meta.url);
const healthTimeoutMs = 1500;

function candidateConfig(previous) {
  const config = previous.toString('utf8');
  const directive = /^([\t ]*proxy_pass[\t ]+)([^;\r\n]+);/gm;
  const [route, secondRoute] = config.matchAll(directive);
  if (route?.[2] !== 'http://app:3000' || secondRoute) {
    throw new Error('Expected one saved proxy_pass to app:3000');
  }
  return Buffer.from(config.replace(directive, '$1http://candidate:3000;'));
}

function checkCandidateHealth() {
  const source = readFileSync(new URL('./probe.mjs', import.meta.url), 'utf8');
  const result = spawnSync('docker', [
    'compose', '--profile', 'routing', 'exec', '-T', 'app',
    'node', '--input-type=module', '-', String(healthTimeoutMs), '0'
  ], {
    cwd: repoRoot,
    input: source,
    encoding: 'utf8',
    timeout: 2 * healthTimeoutMs + 5000
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'Candidate health probe process failed');
  }

  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report.health) || !Array.isArray(report.workload) || report.workload.length) {
    throw new Error('Expected a health-only probe report');
  }
  return report.health;
}

function switchRoute(event) {
  event.stage = 'check_routing_state';
  const state = readRoutingState();
  if (state.deployment_id !== null || state.pending_deployment_id !== null) {
    throw new Error('A deployment already owns the route');
  }

  event.stage = 'read_stable_config';
  const previous = readRuntimeConfig();
  const candidate = candidateConfig(previous);
  const mode = statSync(configPath).mode & 0o777;

  event.stage = 'check_candidate_health';
  event.health = checkCandidateHealth();
  const endpoints = ['/health', '/ready'];
  if (event.health.length !== endpoints.length || event.health.some((check, index) =>
    check?.endpoint !== endpoints[index] || check.http_status !== 200 || check.outcome !== 'ok'
  )) {
    throw new Error('Candidate did not pass /health and /ready');
  }

  event.stage = 'save_route_snapshots';
  const deployment = prepareDeployment(previous, candidate, mode, '1.0.0', '2.0.0');
  const id = deployment.deployment_id;
  event.deployment_id = id;
  const manifest = writeDeployment(deployment, {
    workflow: 'conventional', status: 'CONVENTIONAL_SWITCH_IN_PROGRESS'
  });

  event.stage = 'claim_pending_route';
  if (!readRuntimeConfig().equals(previous)) {
    throw new Error('The saved route changed during the candidate health checks');
  }
  writeRoutingState(null, id);

  event.stage = 'install_candidate_route';
  writeAtomic(configPath, candidate, mode);
  event.stage = 'test_candidate_route';
  nginx('-t');
  event.stage = 'reload_candidate_route';
  nginx('-s', 'reload');

  event.stage = 'publish_active_route';
  writeDeployment(manifest, { status: 'CONVENTIONAL_ACTIVE' });
  writeRoutingState(id, null);
  return 'SWITCHED';
}

function restoreRoute(id, event) {
  event.stage = 'check_route_ownership';
  const state = readRoutingState();
  const active = state.deployment_id === id && state.pending_deployment_id === null;
  const pending = state.pending_deployment_id === id && state.deployment_id === null;
  if (!active && !pending) {
    throw new Error('This deployment does not own the active or pending route');
  }

  let { manifest, previous, candidate } = readDeployment(id);
  if (manifest.workflow !== 'conventional') {
    throw new Error('This route belongs to a different workflow');
  }
  const current = readRuntimeConfig();
  // A pending operation can have left either snapshot installed on disk.
  if (!current.equals(candidate) && !(pending && current.equals(previous))) {
    throw new Error('Installed config does not match the owned route snapshot');
  }

  event.stage = 'claim_pending_restore';
  writeRoutingState(null, id);
  manifest = writeDeployment(manifest, { status: 'CONVENTIONAL_RESTORE_IN_PROGRESS' });

  event.stage = 'install_previous_route';
  if (!current.equals(previous)) {
    writeAtomic(configPath, previous, manifest.config_mode);
  }
  event.stage = 'test_previous_route';
  nginx('-t');
  event.stage = 'reload_previous_route';
  nginx('-s', 'reload');

  event.stage = 'clear_route_ownership';
  writeDeployment(manifest, { status: 'CONVENTIONAL_RESTORED' });
  writeRoutingState(null, null);
  return 'RESTORED';
}

const [action, deploymentId, ...extra] = process.argv.slice(2);
const event = { event: 'conventional_release', action, started_at: new Date().toISOString() };

try {
  event.stage = 'arguments';
  if (extra.length || !((action === 'switch' && deploymentId === undefined) ||
      (action === 'restore' && deploymentId))) {
    throw new Error('Usage: conventional-release.mjs switch | restore <deployment-id>');
  }
  if (deploymentId) event.deployment_id = deploymentId;

  event.stage = 'routing_lock';
  event.status = await withRoutingLock(() => {
    if (action === 'switch') return switchRoute(event);
    return restoreRoute(deploymentId, event);
  });
} catch (error) {
  event.status = 'FAILED';
  event.failed_stage = event.stage;
  event.reason = error.message;
  process.exitCode = 1;
}

delete event.stage;
event.completed_at = new Date().toISOString();
console.log(JSON.stringify(event, null, 2));
