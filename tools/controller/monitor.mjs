import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
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
  operatorDelayMs = null,
  report
}) {
  const candidateVersion = readDeploymentManifest(deploymentId).candidate_version;
  if (typeof candidateVersion !== 'string' || candidateVersion.length === 0) {
    throw new Error('The deployment manifest has no candidate version');
  }

  const qualifies = observation =>
    observation.http_status === 500 && observation.version === candidateVersion;
  let consecutive = 0;
  let firstFailureProbeAt = null;

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
        firstFailureProbeAt = null;
        await sleep(probeIntervalMs);
        continue;
      }
    }

    const nextProbeAt = performance.now() + probeIntervalMs;
    const observation = await observe();
    if (qualifies(observation)) {
      consecutive++;
      if (consecutive === 1) firstFailureProbeAt = new Date().toISOString();
    } else {
      consecutive = 0;
      firstFailureProbeAt = null;
    }

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
          if (operatorDelayMs !== null) {
            return {
              status: 'OPERATOR_DELAY_STARTED', confirmed_at: confirmedAt,
              first_confirmation: confirmation, operator_delay_ms: operatorDelayMs
            };
          }
          return {
            confirmation, confirmed_at: confirmedAt, ...await recover(deployment, confirmation)
          };
        });
      } catch (error) {
        if (!(error instanceof RoutingLockBusyError)) throw error;
        decision = { status: 'LOCK_BUSY' };
      }

      const evidence = {
        deployment_id: deploymentId,
        expected_version: candidateVersion,
        observed_at: observedAt,
        first_failure_probe_at: firstFailureProbeAt,
        consecutive_failures: consecutive,
        observation
      };
      report({ ...evidence, ...decision });

      if (decision.status === 'OPERATOR_DELAY_STARTED') {
        // The first lock has been released. The second attempt must revalidate ownership.
        if (operatorDelayMs > 0) await sleep(operatorDelayMs);
        let rollbackEntered = false;
        let result;
        try {
          result = await lockRouting(async () => {
            const { conflict, deployment } = checkOwnership(deploymentId, candidateVersion);
            if (conflict) return conflict;

            const confirmation = await observe();
            if (!qualifies(confirmation)) return { status: 'DEGRADATION_CLEARED', confirmation };
            const reconfirmedAt = new Date().toISOString();
            rollbackEntered = true;
            return {
              confirmation, reconfirmed_at: reconfirmedAt, ...await recover(deployment, confirmation)
            };
          });
        } catch (error) {
          if (rollbackEntered) throw error;
          result = {
            status: 'DELAYED_ROLLBACK_NOT_STARTED', reason: error.message,
            ...(error instanceof RoutingLockBusyError ? { blocked_by: 'LOCK_BUSY' } : {})
          };
        }
        report({ ...evidence, ...decision, ...result });
        return result.status;
      }

      if (decision.status === 'DEGRADATION_CLEARED') {
        consecutive = 0;
        firstFailureProbeAt = null;
      } else if (decision.status !== 'LOCK_BUSY') {
        return decision.status;
      }
    }

    const remaining = Math.ceil(nextProbeAt - performance.now());
    if (remaining > 0) await sleep(remaining);
  }
}

if (import.meta.main) {
  let deploymentId;
  const report = event => console.log(JSON.stringify(event));
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        reconcile: { type: 'boolean', multiple: true },
        'operator-delay-ms': { type: 'string', multiple: true }
      }
    });
    [deploymentId] = positionals;
    if (positionals.length !== 1 || values.reconcile?.length > 1) {
      throw new Error('Usage: node tools/controller/monitor.mjs [--reconcile | --operator-delay-ms <ms>] <deployment-id>');
    }
    const delays = values['operator-delay-ms'] ?? [];
    if (delays.length > 1) throw new Error('--operator-delay-ms was provided more than once');
    if (values.reconcile && delays.length) {
      throw new Error('--operator-delay-ms cannot be combined with --reconcile');
    }
    const [rawDelay] = delays;
    const operatorDelayMs = rawDelay === undefined ? null : Number(rawDelay);
    if (rawDelay !== undefined && (!/^(0|[1-9]\d*)$/.test(rawDelay) || operatorDelayMs > 2_147_483_647)) {
      throw new Error('--operator-delay-ms needs an integer from 0 to 2147483647 (milliseconds)');
    }
    let status;
    if (values.reconcile) {
      const decision = await reconcileRollback(deploymentId);
      report({ deployment_id: deploymentId, reconciled_at: new Date().toISOString(), ...decision });
      status = decision.status;
    } else {
      status = await monitorDeployment(deploymentId, { operatorDelayMs, report });
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
