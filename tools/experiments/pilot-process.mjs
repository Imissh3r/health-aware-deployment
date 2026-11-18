import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

export function startPilotProcess({ cwd, stagingDir, args, stdout, stderr, signal, timeout }) {
  signal.throwIfAborted();
  const out = openSync(join(stagingDir, stdout), 'wx', 0o600);
  let err;
  let child;
  try {
    err = openSync(join(stagingDir, stderr), 'wx', 0o600);
    child = spawn(process.execPath, args, { cwd, stdio: ['ignore', out, err] });
  } finally {
    if (err !== undefined) closeSync(err);
    closeSync(out);
  }

  let stopReason;
  let forceTimer;
  function stop(reason) {
    if (stopReason || child.exitCode !== null || child.signalCode !== null) return;
    stopReason = reason;
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
    forceTimer.unref();
  }
  const abort = () => stop(signal.reason.message);
  const timeoutTimer = setTimeout(() => stop('Process timed out'), timeout);
  timeoutTimer.unref();
  signal.addEventListener('abort', abort, { once: true });

  let result;
  const finished = new Promise(resolve => {
    let spawnError;
    child.once('error', error => { spawnError = error.message; });
    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(timeoutTimer);
      clearTimeout(forceTimer);
      signal.removeEventListener('abort', abort);
      result = {
        exit_code: exitCode,
        signal: exitSignal,
        ...(spawnError ? { error: spawnError } : {}),
        ...(stopReason ? { stop_reason: stopReason } : {})
      };
      resolve(result);
    });
  });
  return {
    finished,
    stop,
    get exited() { return !!result || child.exitCode !== null || child.signalCode !== null; }
  };
}
