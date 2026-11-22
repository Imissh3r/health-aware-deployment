import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyTrialEvidence } from './formal-trial-classifier.mjs';
import { startTrialClockSampler } from './trial-clock-sampler.mjs';

const initialWallMs = 1_795_167_069_000;

test('records raw clocks at launch, every 250 ms, and once at cleanup start', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: initialWallMs });
  t.mock.method(performance, 'now', () => Date.now() - initialWallMs + 1234.125);
  const sampler = startTrialClockSampler();
  t.after(() => sampler.stop());
  assert.deepEqual(sampler.samples, [{ wall_ms: initialWallMs, monotonic_ms: 1234.125 }]);

  t.mock.timers.tick(249);
  assert.equal(sampler.samples.length, 1);
  t.mock.timers.tick(1);
  t.mock.timers.tick(250);
  t.mock.timers.tick(21);
  const cleanup = sampler.stop({ atCleanupStart: true });
  assert.deepEqual(sampler.samples, [
    { wall_ms: initialWallMs, monotonic_ms: 1234.125 },
    { wall_ms: initialWallMs + 250, monotonic_ms: 1484.125 },
    { wall_ms: initialWallMs + 500, monotonic_ms: 1734.125 },
    { wall_ms: initialWallMs + 521, monotonic_ms: 1755.125 }
  ]);
  assert.equal(cleanup, sampler.samples.at(-1));

  t.mock.timers.tick(1000);
  assert.equal(sampler.stop(), cleanup);
  assert.equal(sampler.stop({ atCleanupStart: true }), cleanup);
  assert.equal(sampler.samples.length, 4);

  const trace = sampler.samples.map(sample => JSON.stringify(sample)).join('\n');
  const { clockIntegrity } = classifyTrialEvidence({
    driver: { wall_start_ms: initialWallMs + 12 },
    trial: { observation: { cleanup_started_ms: cleanup.wall_ms } },
    clockSamples: trace.split('\n').map(line => JSON.parse(line))
  });
  assert.deepEqual(clockIntegrity, {
    status: 'valid', reasonCodes: [], divergenceMs: 0, maxSampleGapMs: 250
  });
});

test('stopping before cleanup preserves samples without adding a boundary', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: initialWallMs });
  const sampler = startTrialClockSampler();
  t.after(() => sampler.stop());
  t.mock.timers.tick(250);
  assert.equal(sampler.stop(), null);
  t.mock.timers.tick(1000);
  assert.equal(sampler.stop({ atCleanupStart: true }), null);
  assert.deepEqual(sampler.samples.map(sample => sample.wall_ms), [initialWallMs, initialWallMs + 250]);
  const { clockIntegrity } = classifyTrialEvidence({
    driver: { wall_start_ms: initialWallMs + 12 },
    clockSamples: sampler.samples
  });
  assert.deepEqual(clockIntegrity, { status: 'invalid', reasonCodes: ['CLOCK_BRACKET_MISSING'] });
});
