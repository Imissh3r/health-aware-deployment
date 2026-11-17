import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { observeProxy } from './observe-proxy.mjs';

const repoRoot = new URL('../../', import.meta.url);
export const configPath = fileURLToPath(new URL('infra/nginx/conf.d/default.conf', repoRoot));

export function nginx(...args) {
  const result = spawnSync('docker', ['compose', '--profile', 'routing', 'exec',
    '-T', 'nginx', 'nginx', ...args], { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `nginx exited with status ${result.status}`);
  }
}

export async function verifyProxy(version, settings) {
  const start = performance.now();
  const deadline = start + settings.verification_window_ms;
  let attempts = 0;
  let consecutive = 0;
  let last = null;

  while (true) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) break;
    attempts++;
    last = await observeProxy(Math.min(remaining, 1000));
    consecutive = last.http_status === 200 && last.version === version ? consecutive + 1 : 0;
    const timeLeft = deadline - performance.now();
    if (consecutive === 3 || timeLeft < 1) break;
    await sleep(Math.min(settings.verification_interval_ms, timeLeft));
  }

  const elapsedMs = performance.now() - start;
  return {
    passed: consecutive === 3 && elapsedMs <= settings.verification_window_ms,
    expected_version: version,
    attempts,
    consecutive,
    elapsed_ms: elapsedMs,
    last_observation: last
  };
}
