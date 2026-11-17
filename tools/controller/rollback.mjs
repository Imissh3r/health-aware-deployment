import { readFileSync } from 'node:fs';
import {
  readDeployment, readRoutingState, requiresRollbackReconciliation, withRoutingLock, writeAtomic,
  writeDeployment, writeRoutingState
} from './deployment-state.mjs';
import { configPath, nginx, verifyProxy } from './nginx-routing.mjs';

const verificationSettings = { verification_window_ms: 5000, verification_interval_ms: 200 };

// The caller holds the routing lock from ownership check through finalization.
export async function rollbackDeployment(deployment, lastObservation, {
  installConfig = writeAtomic,
  runNginx = nginx,
  verify = verifyProxy,
  saveManifest = writeDeployment,
  saveRoutingState = writeRoutingState
} = {}) {
  let { manifest } = deployment;
  const current = readFileSync(configPath);
  const reconciling = requiresRollbackReconciliation(manifest.status);
  const previousInstalled = current.equals(deployment.previous);
  if (!current.equals(deployment.candidate) && !(reconciling && previousInstalled)) {
    return {
      status: reconciling ? 'RECONCILIATION_REFUSED' : 'LOST_OWNERSHIP',
      reason: 'The installed config changed before rollback could start'
    };
  }
  const recovery = {
    started_at: new Date().toISOString(),
    config_installed: previousInstalled,
    proxy_verified: false,
    last_proxy_observation: lastObservation
  };
  let step = 'RECORD_ROLLBACK_ATTEMPT';

  try {
    if (typeof manifest.previous_version !== 'string' || !manifest.previous_version) {
      throw new Error('The deployment manifest has no previous version');
    }
    manifest = saveManifest(manifest, { status: 'ROLLBACK_IN_PROGRESS', rollback: recovery });

    step = 'CONFIG_WRITE';
    if (!recovery.config_installed) {
      installConfig(configPath, deployment.previous, manifest.config_mode);
      recovery.config_installed = true;
    }

    step = 'NGINX_CONFIG_TEST';
    runNginx('-t');
    step = 'NGINX_RELOAD';
    runNginx('-s', 'reload');
    step = 'RECOVERY_VERIFICATION';
    recovery.verification = await verify(manifest.previous_version, verificationSettings);
    recovery.last_proxy_observation =
      recovery.verification.last_observation ?? recovery.last_proxy_observation;
    if (!recovery.verification.passed) {
      throw new Error('Could not verify three consecutive HTTP 200 responses from the previous version');
    }
    recovery.proxy_verified = true;
    recovery.verified_at = new Date().toISOString();

    step = 'RECORD_VERIFIED_RECOVERY';
    manifest = saveManifest(manifest, {
      status: 'RECOVERY_VERIFIED_PENDING_FINALIZATION', rollback: recovery
    });
    step = 'CLEAR_ACTIVE_DEPLOYMENT';
    saveRoutingState(null, null);
    return { status: 'ROLLED_BACK', recovery };
  } catch (error) {
    recovery.failed_step = step;
    recovery.reason = error.message;
    const status = recovery.proxy_verified ? 'FINALIZATION_FAILED' : 'ROLLBACK_FAILED';
    if (step !== 'RECORD_ROLLBACK_ATTEMPT') {
      try {
        saveManifest(manifest, { rollback: recovery });
      } catch (recordError) {
        recovery.record_error = recordError.message;
      }
    }
    return { status, recovery };
  }
}

export async function reconcileRollback(deploymentId, recover = rollbackDeployment) {
  return withRoutingLock(async () => {
    const state = readRoutingState();
    if (state.deployment_id !== deploymentId || state.pending_deployment_id !== null) {
      return { status: 'LOST_OWNERSHIP', reason: 'The routing record does not name this deployment as its sole owner' };
    }

    const deployment = readDeployment(deploymentId);
    if (!requiresRollbackReconciliation(deployment.manifest.status)) {
      return { status: 'RECONCILIATION_REFUSED', reason: 'This deployment has no unresolved rollback' };
    }
    const current = readFileSync(configPath);
    if (!current.equals(deployment.previous) && !current.equals(deployment.candidate)) {
      return { status: 'RECONCILIATION_REFUSED', reason: 'The installed config differs from both deployment snapshots' };
    }

    return recover(deployment, deployment.manifest.rollback?.last_proxy_observation ?? null);
  });
}
