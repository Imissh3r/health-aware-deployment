const sampleIntervalMs = 250;

export function startTrialClockSampler() {
  const samples = [];
  function sample() {
    const reading = { wall_ms: Date.now(), monotonic_ms: performance.now() };
    samples.push(reading);
    return reading;
  }

  sample();
  let timer = setInterval(sample, sampleIntervalMs);
  timer.unref();
  let cleanupSample = null;

  return {
    samples,
    stop({ atCleanupStart = false } = {}) {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        if (atCleanupStart) cleanupSample = sample();
      }
      return cleanupSample;
    }
  };
}
