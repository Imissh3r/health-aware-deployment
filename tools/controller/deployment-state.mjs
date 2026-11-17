import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const deploymentsPath = fileURLToPath(new URL('../../deployments/', import.meta.url));
const routingStatePath = join(deploymentsPath, 'active-deployment.json');
const deploymentIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export class RoutingLockBusyError extends Error {}

export function requiresRollbackReconciliation(status) {
  return status === 'ROLLBACK_IN_PROGRESS' || status === 'RECOVERY_VERIFIED_PENDING_FINALIZATION';
}

function directoryFor(id) {
  if (typeof id !== 'string' || !deploymentIdPattern.test(id)) {
    throw new Error('Invalid deployment ID');
  }
  return join(deploymentsPath, id);
}

export async function withRoutingLock(callback) {
  mkdirSync(deploymentsPath, { recursive: true });
  const fd = openSync(join(deploymentsPath, 'routing.lock'), 'a', 0o600);
  try {
    // flock locks the shared open file description. This process retains fd.
    const result = spawnSync('flock', ['-n', '-E', '75', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8', timeout: 5000
    });
    if (result.error) throw result.error;
    if (result.status === 75) {
      throw new RoutingLockBusyError('Routing lock is held by another operation');
    }
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'Could not acquire routing lock');
    return await callback();
  } finally {
    closeSync(fd);
  }
}

export function writeAtomic(filePath, contents, mode = 0o600) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode });
    renameSync(temporary, filePath);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Preserve the original write or rename error.
    }
    throw error;
  }
}

function writeJson(path, value) {
  writeAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

export function writeRoutingState(activeId, pendingId) {
  writeJson(routingStatePath, {
    deployment_id: activeId,
    pending_deployment_id: pendingId,
    updated_at: new Date().toISOString()
  });
}

export function readRoutingState() {
  let state;
  try {
    state = JSON.parse(readFileSync(routingStatePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { deployment_id: null, pending_deployment_id: null };
    }
    throw error;
  }

  const ids = [state?.deployment_id, state?.pending_deployment_id];
  if (ids.some(id => id !== null && (typeof id !== 'string' || !deploymentIdPattern.test(id))) ||
      ids.every(id => id !== null)) {
    throw new Error('Invalid active-deployment record');
  }
  return state;
}

export function writeDeployment(deployment, updates) {
  const manifest = { ...deployment, ...updates, updated_at: new Date().toISOString() };
  writeJson(join(directoryFor(deployment.deployment_id), 'deployment.json'), manifest);
  return manifest;
}

export function prepareDeployment(previous, candidate, mode, previousVersion, candidateVersion) {
  const id = randomUUID();
  const directory = directoryFor(id);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, 'previous-nginx.conf'), previous, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(directory, 'candidate-nginx.conf'), candidate, { flag: 'wx', mode: 0o600 });
  return writeDeployment({
    deployment_id: id,
    previous_version: previousVersion,
    candidate_version: candidateVersion,
    config_mode: mode,
    created_at: new Date().toISOString()
  }, { status: 'PREPARED' });
}

export function readDeploymentManifest(id) {
  const directory = directoryFor(id);
  const manifest = JSON.parse(readFileSync(join(directory, 'deployment.json'), 'utf8'));
  if (manifest?.deployment_id !== id ||
      !Number.isInteger(manifest.config_mode) || manifest.config_mode < 0 || manifest.config_mode > 0o777) {
    throw new Error('Invalid deployment manifest');
  }
  return manifest;
}

export function readDeployment(id) {
  const manifest = readDeploymentManifest(id);
  const directory = directoryFor(id);
  return {
    manifest,
    previous: readFileSync(join(directory, 'previous-nginx.conf')),
    candidate: readFileSync(join(directory, 'candidate-nginx.conf'))
  };
}
