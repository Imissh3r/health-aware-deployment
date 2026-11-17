import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  readDeployment, readRoutingState, RoutingLockBusyError, withRoutingLock
} from './deployment-state.mjs';
import { observeProxy } from './observe-proxy.mjs';

const configPath = new URL('../../infra/nginx/conf.d/default.conf', import.meta.url);
const probeIntervalMs = 1000;
const probeTimeoutMs = 1000;
const failureThreshold = 3;

function checkOwnership(deploymentId, candidateVersion) {
  const state = readRoutingState();
  const conflict = {
    status: 'LOST_OWNERSHIP',
    active_deployment_id: state.deployment_id,
    pending_deployment_id: state.pending_deployment_id
  };
  if (state.deployment_id !== deploymentId || state.pending_deployment_id !== null) {
    return { ...conflict, reason: 'The routing record does not name this deployment as its sole owner' };
  }

  const { manifest, candidate } = readDeployment(deploymentId);
  if (manifest.status !== 'PROMOTED' || manifest.candidate_version !== candidateVersion) {
    return { ...conflict, reason: 'The deployment manifest no longer matches the monitored promotion' };
  }
  if (!readFileSync(configPath).equals(candidate)) {
    return { ...conflict, reason: 'The installed Nginx config differs from the candidate snapshot' };
  }
  return null;
}

export async function monitorDeployment(deploymentId, {
  observe = () => observeProxy(probeTimeoutMs, { versionStatuses: [200, 500] }),
  lockRouting = withRoutingLock,
  report
}) {
  const { manifest } = readDeployment(deploymentId);
  const candidateVersion = manifest.candidate_version;
  if (typeof candidateVersion !== 'string' || candidateVersion.length === 0) {
    throw new Error('The deployment manifest has no candidate version');
  }

  const qualifies = observation =>
    observation.http_status === 500 && observation.version === candidateVersion;
  let consecutive = 0;

  while (true) {
    const nextProbeAt = performance.now() + probeIntervalMs;
    const observation = await observe();
    consecutive = qualifies(observation) ? consecutive + 1 : 0;

    if (consecutive >= failureThreshold) {
      let decision;
      try {
        decision = await lockRouting(async () => {
          const conflict = checkOwnership(deploymentId, candidateVersion);
          if (conflict) return conflict;

          const confirmation = await observe();
          const status = qualifies(confirmation) ? 'DEGRADATION_CONFIRMED' : 'DEGRADATION_CLEARED';
          return { status, confirmation };
        });
      } catch (error) {
        if (!(error instanceof RoutingLockBusyError)) throw error;
        decision = { status: 'LOCK_BUSY' };
      }

      report({
        deployment_id: deploymentId,
        expected_version: candidateVersion,
        observed_at: new Date().toISOString(),
        consecutive_failures: consecutive,
        observation,
        ...decision
      });

      if (decision.status === 'DEGRADATION_CONFIRMED' || decision.status === 'LOST_OWNERSHIP') {
        return decision.status;
      }
      if (decision.status === 'DEGRADATION_CLEARED') consecutive = 0;
    }

    const remaining = Math.ceil(nextProbeAt - performance.now());
    if (remaining > 0) await sleep(remaining);
  }
}

if (import.meta.main) {
  const deploymentId = process.argv[2];
  const report = event => console.log(JSON.stringify(event));
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node tools/controller/monitor.mjs <deployment-id>');
    const status = await monitorDeployment(deploymentId, { report });
    if (status === 'LOST_OWNERSHIP') process.exitCode = 2;
  } catch (error) {
    report({
      status: 'MONITOR_FAILED', deployment_id: deploymentId ?? null,
      observed_at: new Date().toISOString(), reason: error.message
    });
    process.exitCode = 1;
  }
}
