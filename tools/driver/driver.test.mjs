import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Exercise the CLI and real scheduler without contacting a server.
const stub = `
  const hrtime = process.hrtime.bigint;
  process.hrtime.bigint = () => hrtime() + (1n << 60n);
  globalThis.fetch = async () => new Response('{"version":"1.0.0"}');
`;
const driver = fileURLToPath(new URL('./driver.js', import.meta.url));

async function runDriver(t, { notify = false, ipc = true, setup = '' } = {}) {
  const out = await mkdtemp(join(tmpdir(), 'driver-start-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const preload = 'data:text/javascript,' + encodeURIComponent(stub + setup);
  const child = spawn(process.execPath, [
    '--import', preload, driver, '--url', 'http://127.0.0.1/api/work',
    '--rate', '2', '--duration', '1', '--warmup', '0',
    '--out', out, '--run-id', 'fixture', ...(notify ? ['--notify-start'] : [])
  ], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
  let stdout = '';
  let stderr = '';
  const messages = [];
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.on('message', message => messages.push(message));
  assert.deepEqual(await once(child, 'close'), [0, null], stderr);
  const run = JSON.parse(await readFile(join(out, 'fixture', 'run.json'), 'utf8'));
  const csv = await readFile(join(out, 'fixture', 'requests.csv'), 'utf8');
  return { messages, run, csv, stdout, stderr };
}

test('Driver startup IPC reuses the exact final bracket and preserves legacy outputs', async t => {
  const [enabled, disabled] = await Promise.all([runDriver(t, { notify: true }), runDriver(t)]);
  assert.deepEqual(disabled.messages, []);
  assert.equal(enabled.messages.length, 1);
  const [message] = enabled.messages;
  const { end_before_ns, end_after_ns, elapsed_ns, ...start } = enabled.run.clock_alignment;
  assert.deepEqual(message, { event: 'driver_start', run_id: 'fixture', clock_alignment: start });
  for (const value of [start.start_before_ns, start.start_after_ns]) {
    assert.match(value, /^\d+$/);
    assert.ok(BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER));
  }
  assert.ok(BigInt(start.start_after_ns) >= BigInt(start.start_before_ns));
  assert.ok(BigInt(end_after_ns) >= BigInt(end_before_ns));
  assert.ok(BigInt(elapsed_ns) > 0n);
  assert.equal(enabled.stdout, disabled.stdout);
  assert.equal(enabled.stderr, '');
  assert.equal(disabled.stderr, '');
  assert.deepEqual(Object.keys(enabled.run), Object.keys(disabled.run));
  assert.deepEqual(Object.keys(enabled.run.options), Object.keys(disabled.run.options));
  assert.deepEqual(enabled.run.summary, disabled.run.summary);
  assert.deepEqual(enabled.run.invariants, disabled.run.invariants);
  const records = csv => csv.trimEnd().split('\n').map((line, index) => {
    if (!index) return line;
    const fields = line.split(',');
    assert.ok(Number(fields[3]) >= Number(fields[2]));
    assert.ok(Number(fields[4]) >= Number(fields[3]));
    return [...fields.slice(0, 3), ...fields.slice(7)];
  });
  assert.deepEqual(records(enabled.csv), records(disabled.csv));
  assert.deepEqual(records(enabled.csv).slice(1).map(row => row.slice(1, 3)), [['1', '0'], ['2', '500']]);
});

test('Driver reports a missing notification channel without changing request accounting', async t => {
  const { messages, stderr, run, stdout } = await runDriver(t, { notify: true, ipc: false });
  assert.deepEqual(messages, []);
  assert.match(stderr, /Driver start notification failed: No connected IPC channel/);
  assert.equal(run.status, 'complete');
  assert.equal(run.summary.settled, 2);
  assert.deepEqual(JSON.parse(stdout), run.summary.outcomes);
});


test('Driver dispatches while notification delivery is pending and reports a send failure', async t => {
  const setup = `
    let delivery;
    process.send = (_message, callback) => { delivery = callback; return false; };
    const fetch = globalThis.fetch;
    globalThis.fetch = (...args) => {
      if (delivery) {
        delivery(new Error('fixture delivery error'));
        delivery = null;
      }
      return fetch(...args);
    };
  `;
  const { messages, stderr, run } = await runDriver(t, { notify: true, setup });
  assert.deepEqual(messages, []);
  assert.match(stderr, /Driver start notification failed: fixture delivery error/);
  assert.equal(run.status, 'complete');
  assert.equal(run.summary.settled, 2);
});
