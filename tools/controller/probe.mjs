const timeoutMs = Number(process.argv[2]);
const workloadCount = Number(process.argv[3]);
const candidate = 'http://candidate:3000';

async function probe(endpoint) {
  const signal = AbortSignal.timeout(timeoutMs);
  const start = performance.now();
  let httpStatus = null;
  let body;

  try {
    const response = await fetch(candidate + endpoint, { signal, redirect: 'manual' });
    httpStatus = response.status;
    body = await response.text();
  } catch (error) {
    if (!signal.aborted && !(error instanceof TypeError && error.cause)) throw error;
    return {
      endpoint,
      outcome: signal.aborted ? 'timeout' : 'connection_error',
      http_status: httpStatus,
      latency_ms: performance.now() - start,
      error_code: error.cause?.code ?? error.code ?? error.name
    };
  }

  const latencyMs = performance.now() - start;
  let version = null;
  if (endpoint === '/api/work') {
    try {
      version = JSON.parse(body)?.version ?? null;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  return {
    endpoint,
    outcome: httpStatus === 200 ? 'ok' : 'http_error',
    http_status: httpStatus,
    latency_ms: latencyMs,
    version
  };
}

const health = [await probe('/health')];
if (health[0].outcome === 'ok') health.push(await probe('/ready'));

const workload = [];
if (health.length === 2 && health[1].outcome === 'ok') {
  for (let i = 0; i < workloadCount; i++) {
    workload.push(await probe('/api/work'));
  }
}

console.log(JSON.stringify({ health, workload }));
