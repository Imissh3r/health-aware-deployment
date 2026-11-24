import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFormalHealthyRelease } from './run-formal-healthy-release.mjs';

const second = 1_000_000_000n;
const base = 1_000n * second;
const frozen = {
  project: 's1-fixture', proxyUrl: 'http://127.0.0.1:18080/api/work',
  stableConfigSha256: '0'.repeat(64), environmentFingerprint: 's1-fixture'
};
const clear = { deployment_id: null, pending_deployment_id: null };
const owner = { deployment_id: 'fixture-deployment', pending_deployment_id: null };
const success = version => ({ http_status: 200, version });

async function fixture(t, config = {}) {
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'formal-s1-'));
  t.after(() => rm(evidenceRoot, { recursive: true, force: true }));
  const arm = config.arm ?? 'H';
  let now = base;
  let state = clear;
  let deployAt;
  let stopped = false;
  let monitorStops = 0;
  const tasks = [];
  const trace = [];
  const schedule = (at, callback) => tasks.push({ at, callback });
  const start = base + second;
  const projection = {
    version: 1, source: 'process.hrtime.bigint',
    start_before_ns: String(start - 10n), start_after_ns: String(start + 10n)
  };
  const finished = Promise.withResolvers();
  const ops = {
    now: () => now,
    waitUntil(at, signal) {
      if (at <= now || signal?.aborted) return Promise.resolve();
      return new Promise(resolve => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          resolve();
        };
        if (signal) signal.addEventListener('abort', wake, { once: true });
        schedule(at, () => { if (!signal?.aborted) wake(); });
      });
    },
    async preflight() {
      if (config.preflightFails) throw new Error('frozen snapshot mismatch');
      return { ok: true };
    },
    routingState: () => state,
    startDriver(args, onMessage) {
      const arg = name => args[args.indexOf('--' + name) + 1];
      assert.ok(args.includes('--notify-start'));
      assert.deepEqual(['rate', 'duration', 'warmup', 'timeout', 'max-concurrency', 'max-lateness'].map(arg),
        ['5', '120', '5', '3000', '50', '200']);
      const runId = arg('run-id');
      const finishAt = start + BigInt(config.finish ?? 120) * second;
      if (!config.noNotification) {
        schedule(start + 20n, () => onMessage({ event: 'driver_start', run_id: runId, clock_alignment: projection }));
      }
      schedule(finishAt, () => {
        if (stopped) return;
        trace.push(['driver_finish', now]);
        const output = join(arg('out'), runId);
        mkdirSync(output);
        const options = {
          rate: 5, duration_seconds: 120, warmup_seconds: 5,
          timeout_ms: 3000, max_concurrency: 50, max_lateness_ms: 200
        };
        const duration = config.finish ?? 120;
        const run = { run_id: runId, status: duration < 120 ? 'incomplete' : 'complete',
          options, target_url: frozen.proxyUrl,
          clock_alignment: { ...projection,
            ...(config.badFinalClock && { start_before_ns: String(start - 11n) }),
            end_before_ns: String(finishAt - 10n), end_after_ns: String(finishAt),
            elapsed_ns: String(finishAt - start)
          } };
        writeFileSync(join(output, 'run.json'), JSON.stringify(run));
        const header = 'run_id,seq,scheduled_ms,dispatched_ms,completed_ms,dispatch_delay_ms,latency_ms,outcome,http_status,error_code,miss_reason,version,warmup';
        const rows = Array.from({ length: duration * 5 }, (_, index) => {
          const ms = index * 200;
          const relative = start + BigInt(ms) * 1_000_000n - (deployAt ?? finishAt);
          const candidateBegins = config.earlyRegression ? 1_600_000_000n : second;
          const version = !config.failure && relative > candidateBegins &&
            (!config.regression || relative < 10n * second) &&
            (!config.earlyRegression || relative < 2n * second || relative >= 4n * second) ? '2.0.0' : '1.0.0';
          return [runId, index + 1, ms, ms, ms + 10, 0, 10, 'ok', 200, '', '', version, ms < 5000].join(',');
        });
        writeFileSync(join(output, 'requests.csv'), [header, ...rows].join('\n') + '\n');
        finished.resolve({ exitCode: duration < 120 ? 1 : 0 });
      });
      return { finished: finished.promise, stop() { stopped = true; finished.resolve({ signal: 'SIGTERM' }); } };
    },
    driverRunning() {
      if (config.slowWarmup) now += 75n * second;
      return !stopped;
    },
    async deploy() {
      deployAt = now;
      trace.push(['deploy', now]);
      if (config.deploymentTimeout) {
        const timedOut = Promise.withResolvers();
        schedule(now + 5n * second, () => {
          state = config.timeoutState ?? clear;
          timedOut.resolve({
            timedOut: true, signal: 'SIGKILL', error: 'fixture timeout',
            stdout: 'partial deployment output', stderr: 'deployment diagnostics'
          });
        });
        return timedOut.promise;
      }
      if (!config.failure) state = owner;
      const status = config.failure ?? (arm === 'H' ? 'PROMOTED' : 'SWITCHED');
      return { exitCode: config.failure ? 1 : 0, stdout: JSON.stringify({
        event: arm === 'H' ? 'candidate_promotion' : 'conventional_release', action: 'switch',
        status, ...(config.failure ? {} : { deployment_id: owner.deployment_id })
      }) };
    },
    startMonitor(_id, horizon, report) {
      trace.push(['monitor', now]);
      const done = Promise.withResolvers();
      if (config.regression) schedule(deployAt + 10n * second, () => {
        state = clear;
        report({ type: 'report', value: { status: 'ROLLED_BACK' } });
        done.resolve({ exitCode: 0 });
      });
      if (config.foreignOwner) schedule(deployAt + 30n * second, () => {
        state = { ...owner, deployment_id: 'foreign' };
      });
      if (config.hungMonitor) schedule(horizon + 45n * second, () => done.resolve({ exitCode: 0 }));
      return { finished: done.promise, stop() {
        monitorStops++;
        trace.push(['monitor_stop', now]);
        if (!config.hungMonitor) done.resolve({ exitCode: 0 });
      } };
    },
    async observe() {
      if (config.observerFails) throw new Error('observer unavailable');
      trace.push(['probe', now]);
      const relative = now - deployAt;
      const regression = config.earlyRegression && relative >= 2n * second && relative < 4n * second;
      return success(state === owner && !regression ? '2.0.0' : '1.0.0');
    },
    async restore(_arm, _owner, onControllerResult) {
      trace.push(['restore', now]);
      if (config.cleanupTimeout) {
        const result = { status: 'RESTORED', event: 'conventional_release', action: 'restore',
          deployment_id: owner.deployment_id };
        onControllerResult({ timedOut: true, signal: 'SIGKILL', error: 'fixture timeout',
          stdout: JSON.stringify(result), stderr: 'restore diagnostics' });
        return result;
      }
      if (config.cleanupFails) throw new Error('restore failed');
      state = clear;
      return { status: 'RESTORED' };
    },
    async reset() {
      trace.push(['reset', now]);
      assert.equal(state, clear);
      if (config.resetFails) throw new Error('stable route unverified');
      return { cleared: true };
    }
  };
  const input = { arm, trialId: 'trial', evidenceRoot, frozen };
  const result = runFormalHealthyRelease(input, ops);
  let done = false;
  result.then(() => { done = true; }, () => { done = true; });
  for (let tick = 0; !done && tick < 400; tick++) {
    await new Promise(resolve => setImmediate(resolve));
    if (done) break;
    tasks.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
    const next = tasks.shift();
    assert.ok(next, 'Runner stalled without a scheduled operation');
    if (now < next.at) now = next.at;
    next.callback();
  }
  assert.ok(done, 'Runner did not settle');
  const summary = await result;
  const read = name => readFile(join(summary.directory, name), 'utf8');
  return {
    summary, trace, monitorStops, input, ops, read,
    classifier: JSON.parse(await read('classifier.json')),
    events: (await read('events.jsonl')).trimEnd().split('\n').map(JSON.parse)
  };
}

test('H uses the measured bracket, verifies candidate independently, and cleans up after drain', async t => {
  const { summary, trace, classifier, events, input, ops } = await fixture(t);
  assert.equal(summary.validity.status, 'valid');
  assert.equal(summary.workflow.deployment, 'PROMOTED');
  assert.equal(summary.nextArmAllowed, true);
  assert.equal(summary.client_coverage.clock_matches, true);
  assert.equal(classifier.result.candidate.primary.status, 'observed');
  assert.equal(classifier.result.candidate.primary.milestone.requestIds.length, 3);
  assert.equal(classifier.result.accounting.offered.length, 300);
  assert.equal(summary.observer.verification.sample_ids.length, 3);
  const arrival = events.find(event => event.event === 'driver_start_notification_received');
  const inv = BigInt(summary.origin.host_monotonic_ns);
  assert.equal(inv, BigInt(arrival.payload.clock_alignment.start_after_ns) + 5n * second);
  assert.notEqual(arrival.host_monotonic_ns, arrival.payload.clock_alignment.start_after_ns);
  assert.ok(trace.find(([event]) => event === 'restore')[1] >= trace.find(([event]) => event === 'driver_finish')[1]);
  assert.ok(events.some(event => event.event === 'external_probe' && event.after_primary_cutoff));
  await assert.rejects(runFormalHealthyRelease(input, ops), { code: 'EEXIST' });
});

test('C switches and uses the same client classifier without a monitor', async t => {
  const { summary, classifier, trace, monitorStops } = await fixture(t, { arm: 'C' });
  assert.equal(summary.workflow.deployment, 'SWITCHED');
  assert.equal(classifier.result.candidate.primary.status, 'observed');
  assert.equal(summary.validity.status, 'valid');
  assert.equal(monitorStops, 0);
  assert.ok(!trace.some(([event]) => event === 'monitor'));
});

for (const [arm, failure] of [['H', 'PROMOTION_BLOCKED'], ['H', 'PROMOTION_FAILED'], ['C', 'FAILED']]) {
  test(`${arm} ${failure} remains a measured adverse outcome through cutoff`, async t => {
    const { summary, classifier, trace } = await fixture(t, { arm, failure });
    assert.equal(summary.workflow.deployment, failure);
    assert.equal(summary.validity.status, 'valid');
    assert.equal(summary.observer.primary_covered, true);
    assert.equal(classifier.result.candidate.primary.status, 'not_observed');
    assert.ok(trace.some(([event, at]) => event === 'probe' && at > BigInt(summary.origin.cutoff_ns)));
    assert.equal(summary.cleanup.status, 'not_required');
  });
}

test('missing startup and a delayed warm-up cannot invoke deployment', async t => {
  for (const config of [{ noNotification: true }, { slowWarmup: true }]) {
    const { summary, trace } = await fixture(t, config);
    assert.equal(summary.workflow.deployment, 'NOT_INVOKED');
    assert.equal(summary.validity.status, 'invalid');
    assert.ok(!trace.some(([event]) => ['deploy', 'restore'].includes(event)));
  }
});

test('an observer failure leaves independently usable client evidence', async t => {
  const { summary, classifier } = await fixture(t, { observerFails: true });
  assert.equal(summary.observer.status, 'failed');
  assert.equal(summary.metrics.external_verification, 'insufficient');
  assert.equal(summary.metrics.request_accounting, 'complete');
  assert.equal(classifier.result.candidate.primary.status, 'observed');
  assert.equal(summary.validity.status, 'needs_review');
});

test('early driver finalization is a coverage problem and never causes early cleanup', async t => {
  const { summary, trace } = await fixture(t, { finish: 55 });
  assert.equal(summary.client_coverage.primary_covered, false);
  assert.equal(summary.observer.primary_covered, true);
  assert.equal(summary.validity.status, 'needs_review');
  assert.ok(trace.find(([event]) => event === 'restore')[1] >= BigInt(summary.origin.cutoff_ns));
});

test('final bracket mismatch makes the measurement invalid while preserving raw classification', async t => {
  const { summary, classifier } = await fixture(t, { badFinalClock: true });
  assert.equal(summary.client_coverage.clock_matches, false);
  assert.equal(summary.validity.status, 'invalid');
  assert.equal(classifier.result.candidate.primary.status, 'observed');
});

test('an unexpected rollback is preserved and does not invalidate an observed trial', async t => {
  const { summary } = await fixture(t, { regression: true });
  assert.equal(summary.workflow.deployment, 'PROMOTED');
  assert.equal(summary.workflow.monitor_outcomes[0].status, 'ROLLED_BACK');
  assert.ok(summary.workflow.route_regressions.length > 0);
  assert.equal(summary.cleanup.status, 'not_required');
  assert.equal(summary.validity.status, 'valid');
});

test('cleanup failure preserves classification and blocks continuation', async t => {
  const { summary, trace, classifier } = await fixture(t, { cleanupFails: true });
  assert.equal(summary.cleanup.status, 'failed');
  assert.equal(summary.nextArmAllowed, false);
  assert.equal(summary.validity.status, 'valid');
  assert.equal(classifier.result.candidate.primary.status, 'observed');
  assert.ok(!trace.some(([event]) => event === 'reset'));
});

test('foreign ownership and unsettled monitoring block restore and reset', async t => {
  for (const config of [{ foreignOwner: true }, { hungMonitor: true }]) {
    const { summary, trace } = await fixture(t, config);
    assert.equal(summary.nextArmAllowed, false);
    assert.equal(summary.cleanup.status, 'blocked');
    assert.ok(!trace.some(([event]) => ['restore', 'reset'].includes(event)));
  }
});


test('preflight and post-cleanup reset failures preserve their separate evidence', async t => {
  const blocked = await fixture(t, { preflightFails: true });
  assert.equal(blocked.summary.validity.status, 'invalid');
  assert.equal(blocked.summary.nextArmAllowed, false);
  assert.equal(blocked.events[0].event, 'trial_started');
  assert.deepEqual(blocked.trace, []);

  const unverified = await fixture(t, { resetFails: true });
  assert.equal(unverified.summary.cleanup.status, 'completed');
  assert.equal(unverified.summary.reset.status, 'failed');
  assert.equal(unverified.summary.validity.status, 'valid');
  assert.equal(unverified.summary.nextArmAllowed, false);
  assert.equal(unverified.classifier.result.candidate.primary.status, 'observed');
});


test('early stable regression survives subsequent external and client verification', async t => {
  const { summary, classifier, events } = await fixture(t, { earlyRegression: true });
  const externalFirst = BigInt(summary.observer.first_candidate.host_monotonic_ns);
  const externalVerified = BigInt(summary.observer.verification.host_monotonic_ns);
  const externalRegressions = events.filter(event => summary.workflow.route_regressions.includes(event.id));
  assert.ok(externalRegressions.some(event => event.observation.version === '1.0.0' &&
    externalFirst < BigInt(event.host_monotonic_ns) && BigInt(event.host_monotonic_ns) < externalVerified));

  const result = classifier.result;
  const clientFirst = BigInt(result.candidate.firstSuccess.completion[1]);
  const clientVerified = BigInt(result.candidate.primary.milestone.certification[0]);
  const clientRegressions = result.trace.rows.filter(row => summary.workflow.client_route_regression_request_ids.includes(row.seq));
  assert.ok(clientRegressions.some(row => row.version === '1.0.0' &&
    clientFirst < BigInt(row.dispatch_time[0]) && BigInt(row.completion_time[1]) < clientVerified));
});

test('deployment timeout retains controller evidence and blocks cleanup even if ownership looks clear', async t => {
  for (const timeoutState of [clear, { deployment_id: null, pending_deployment_id: 'foreign' }]) {
    const { summary, trace, classifier, read } = await fixture(t, { deploymentTimeout: true, timeoutState });
    assert.equal(summary.controller.timed_out, true);
    assert.equal(summary.controller.signal, 'SIGKILL');
    assert.equal(summary.workflow.deployment, 'UNKNOWN');
    assert.equal(summary.cleanup.status, 'blocked');
    assert.equal(summary.reset.status, 'unverified');
    assert.equal(summary.nextArmAllowed, false);
    assert.ok(trace.some(([event, at]) => event === 'probe' && at > BigInt(summary.origin.cutoff_ns)));
    assert.ok(!trace.some(([event]) => ['restore', 'reset'].includes(event)));
    assert.equal(classifier.result.accounting.completeness, 'complete');
    assert.equal(await read('deployment.stdout.log'), 'partial deployment output');
    assert.equal(await read('deployment.stderr.log'), 'deployment diagnostics');
  }
});

test('conventional cleanup timeout retains evidence and cannot certify restoration', async t => {
  const { summary, trace, classifier, read, events } = await fixture(t, { arm: 'C', cleanupTimeout: true });
  assert.equal(summary.cleanup.status, 'timed_out');
  assert.equal(summary.reset.status, 'unverified');
  assert.equal(summary.nextArmAllowed, false);
  assert.equal(summary.validity.status, 'valid');
  assert.equal(classifier.result.candidate.primary.status, 'observed');
  assert.ok(!trace.some(([event]) => event === 'reset'));
  assert.equal(events.find(event => event.id === summary.cleanup.event.controller_event_id).timed_out, true);
  assert.equal(JSON.parse(await read('cleanup-controller.stdout.log')).status, 'RESTORED');
  assert.equal(await read('cleanup-controller.stderr.log'), 'restore diagnostics');
});
