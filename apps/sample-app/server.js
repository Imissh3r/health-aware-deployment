import express from 'express';

const app = express();

const PORT = process.env.PORT || 3000;
const VERSION = process.env.APP_VERSION || '1.0.0';

// root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Health-aware deployment sample app',
    version: VERSION
  });
});

// health endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// ready endpoint
app.get('/ready', (req, res) => {
  res.status(200).json({ status: 'ready' });
});

// Testing deterministic failure under /api/work endpoint
const ERROR_EVERY_N_REQUESTS = Number(
  process.env.ERROR_EVERY_N_REQUESTS ?? 0
);

if (
  !Number.isInteger(ERROR_EVERY_N_REQUESTS) ||
  ERROR_EVERY_N_REQUESTS < 0
) {
  throw new Error(
    'ERROR_EVERY_N_REQUESTS must be a non-negative integer'
  );
}

let workRequestCount = 0;

app.get('/api/work', (req, res) => {
  workRequestCount += 1;

  if (
    ERROR_EVERY_N_REQUESTS > 0 &&
    workRequestCount % ERROR_EVERY_N_REQUESTS === 0
  ) {
    return res.status(500).json({
      status: 'error',
      message: 'Simulated failure',
      request: workRequestCount,
      version: VERSION
    });
  }

  res.json({
    status: 'ok',
    request: workRequestCount,
    version: VERSION
  });
});

const server = app.listen(PORT, () => {
  console.log(`App version ${VERSION} listening on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);

  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  // Close idle connections immediately.
  server.closeIdleConnections();

  // Force-close remaining connections after 1 second.
  setTimeout(() => {
    console.log('Closing remaining HTTP connections...');
    server.closeAllConnections();
  }, 1000).unref();

  // Final safety net.
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 3000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));