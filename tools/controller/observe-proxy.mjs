const proxyUrl = process.env.DEPLOYMENT_PROXY_URL ?? 'http://127.0.0.1:8080/api/work';

export async function observeProxy(timeoutMs, { url = proxyUrl, versionStatuses = [200] } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let status = null;
  try {
    const response = await fetch(url, {
      signal, redirect: 'manual', headers: { Connection: 'close' }
    });
    status = response.status;
    if (versionStatuses.includes(status)) {
      const body = await response.json();
      return { http_status: status, version: body?.version ?? null };
    }
    await response.body?.cancel();
    return { http_status: status, version: null };
  } catch (error) {
    return { http_status: status, version: null, error: error.message };
  }
}
