import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  readDeployment, readDeploymentManifest, readRoutingState, requiresRollbackReconciliation,
  RoutingLockBusyError, withRoutingLock
} from './deployment-state.mjs';
import { configPath } from './nginx-routing.mjs';
import { observeProxy } from './observe-proxy.mjs';
import { reconcileRollback, rollbackDeployment } from './rollback.mjs';

const probeIntervalMs = 1000;
const probeTimeoutMs = 1000;
const failureThreshold = 3;

function reconciliationRequired(manifest) {
  return {
    status: 'RECONCILIATION_REQUIRED',
    manifest_status: manifest.status,
    reason: 'Run monitor.mjs --reconcile with this deployment ID to resume rollback'
  };
}

function checkOwnership(deploymentId, candidateVersion) {
  const state = readRoutingState();
  const conflict = {
    status: 'LOST_OWNERSHIP',
    active_deployment_id: state.deployment_id,
    pending_deployment_id: state.pending_deployment_id
  };
  if (state.deployment_id !== deploymentId || state.pending_deployment_id !== null) {
    return { conflict: { ...conflict, reason: 'The routing record does not name this deployment as its sole owner' } };
  }

  const deployment = readDeployment(deploymentId);
  const { manifest, candidate } = deployment;
  if (requiresRollbackReconciliation(manifest.status)) {
    return { conflict: reconciliationRequired(manifest) };
  }
  if (manifest.status !== 'PROMOTED' || manifest.candidate_version !== candidateVersion) {
    return { conflict: { ...conflict, reason: 'The deployment manifest no longer matches the monitored promotion' } };
  }
  if (!readFileSync(configPath).equals(candidate)) {
    return { conflict: { ...conflict, reason: 'The installed Nginx config differs from the candidate snapshot' } };
  }
  return { deployment };
}

export async function monitorDeployment(deploymentId, {
  observe = () => observeProxy(probeTimeoutMs, { versionStatuses: [200, 500] }),
  lockRouting = withRoutingLock,
  recover = rollbackDeployment,
  report
}) {
  const candidateVersion = readDeploymentManifest(deploymentId).candidate_version;
  if (typeof candidateVersion !== 'string' || candidateVersion.length === 0) {
    throw new Error('The deployment manifest has no candidate version');
  }

  const qualifies = observation =>
    observation.http_status === 500 && observation.version === candidateVersion;
  let consecutive = 0;

  while (true) {
    const manifest = readDeploymentManifest(deploymentId);
    if (requiresRollbackReconciliation(manifest.status)) {
      // Another monitor may still be finalizing this attempt under the lock.
      try {
        const { conflict } = await lockRouting(() => checkOwnership(deploymentId, candidateVersion));
        if (conflict) {
          report({ deployment_id: deploymentId, observed_at: new Date().toISOString(), ...conflict });
          return conflict.status;
        }
      } catch (error) {
        if (!(error instanceof RoutingLockBusyError)) throw error;
        consecutive = 0;
        await sleep(probeIntervalMs);
        continue;
      }
    }

    const nextProbeAt = performance.now() + probeIntervalMs;
    const observation = await observe();
    consecutive = qualifies(observation) ? consecutive + 1 : 0;

    if (consecutive >= failureThreshold) {
      const observedAt = new Date().toISOString();
      let decision;
      try {
        decision = await lockRouting(async () => {
          const { conflict, deployment } = checkOwnership(deploymentId, candidateVersion);
          if (conflict) return conflict;

          const confirmation = await observe();
          if (!qualifies(confirmation)) return { status: 'DEGRADATION_CLEARED', confirmation };
          const confirmedAt = new Date().toISOString();
          return {
            confirmation, confirmed_at: confirmedAt, ...await recover(deployment, confirmation)
          };
        });
      } catch (error) {
        if (!(error instanceof RoutingLockBusyError)) throw error;
        decision = { status: 'LOCK_BUSY' };
      }

      report({
        deployment_id: deploymentId,
        expected_version: candidateVersion,
        observed_at: observedAt,
        consecutive_failures: consecutive,
        observation,
        ...decision
      });

      if (decision.status === 'DEGRADATION_CLEARED') consecutive = 0;
      else if (decision.status !== 'LOCK_BUSY') return decision.status;
    }

    const remaining = Math.ceil(nextProbeAt - performance.now());
    if (remaining > 0) await sleep(remaining);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const reconcile = args[0] === '--reconcile';
  const deploymentId = args[reconcile ? 1 : 0];
  const report = event => console.log(JSON.stringify(event));
  try {
    if (args.length !== (reconcile ? 2 : 1)) {
      throw new Error('Usage: node tools/controller/monitor.mjs [--reconcile] <deployment-id>');
    }
    let status;
    if (reconcile) {
      const decision = await reconcileRollback(deploymentId);
      report({ deployment_id: deploymentId, reconciled_at: new Date().toISOString(), ...decision });
      status = decision.status;
    } else {
      status = await monitorDeployment(deploymentId, { report });
    }
    if (status === 'LOST_OWNERSHIP') process.exitCode = 2;
    else if (status !== 'ROLLED_BACK') process.exitCode = 1;
  } catch (error) {
    report({
      status: 'MONITOR_FAILED', deployment_id: deploymentId ?? null,
      observed_at: new Date().toISOString(), reason: error.message
    });
    process.exitCode = 1;
  }
}
