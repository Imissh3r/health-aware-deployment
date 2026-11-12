import express from 'express';
import { pool } from './db.js';

const app = express();

const PORT = process.env.PORT || 3000;
const VERSION = process.env.APP_VERSION || '1.0.0';

// Testing response delay failures
function readNonNegativeInt(name) {
  const raw = process.env[name];
  if (raw === undefined) return 0;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`${name} must be a non-negative integer (got "${raw}")`);
    process.exit(1);
  }
  return value;
}

const ERROR_EVERY_N_REQUESTS =
  readNonNegativeInt('ERROR_EVERY_N_REQUESTS');

const RESPONSE_DELAY_MS =
  readNonNegativeInt('RESPONSE_DELAY_MS');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// Readiness check: verify database connectivity
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.status(200).json({
      status: 'ready'
    });
  } catch (error) {
    console.error('Database readiness check failed:', error.message);

    res.status(503).json({
      status: 'not_ready',
      reason: 'database_unavailable'
    });
  }
});

let workRequestCount = 0;

app.get('/api/work', async (req, res) => {
  workRequestCount += 1;

  if (RESPONSE_DELAY_MS > 0) {
    await sleep(RESPONSE_DELAY_MS);
  }

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

  server.close(async () => {
    console.log('HTTP server closed');

    try {
      await pool.end();
      console.log('PostgreSQL connection pool closed');
      process.exit(0);
    } catch (error) {
      console.error('Failed to close PostgreSQL pool:', error.message);
      process.exit(1);
    }
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