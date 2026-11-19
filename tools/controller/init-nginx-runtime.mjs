import { randomUUID } from 'node:crypto';
import {
  closeSync, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { dirname } from 'node:path';
import { readRoutingState, withRoutingLock } from './deployment-state.mjs';
import { configPath } from './nginx-routing.mjs';

const templatePath = new URL('../../infra/nginx/conf.d/default.conf', import.meta.url);

function runtimeFileExists() {
  const entry = lstatSync(configPath, { throwIfNoEntry: false });
  if (!entry) return false;
  if (!entry.isFile()) throw new Error('Nginx runtime config destination must be a regular file');
  return true;
}

function initializeRuntimeConfig() {
  if (runtimeFileExists()) return 'preserved';

  const { deployment_id: active, pending_deployment_id: pending } = readRoutingState();
  if (active !== null || pending !== null) {
    throw new Error('Both deployment IDs must be clear before initializing the runtime config');
  }

  const template = readFileSync(templatePath);
  mkdirSync(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, template);
      fchmodSync(fd, 0o644);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, configPath);
      return 'initialized';
    } catch (error) {
      if (error.code === 'EEXIST' && runtimeFileExists()) return 'preserved';
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
}

try {
  const status = await withRoutingLock(initializeRuntimeConfig);
  console.log(JSON.stringify({ status, config_path: configPath }));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', config_path: configPath, reason: error.message }));
  process.exitCode = 1;
}
