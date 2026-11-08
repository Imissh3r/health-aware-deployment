import express from 'express';

const app = express();

const PORT = process.env.PORT || 3000;
const VERSION = process.env.APP_VERSION || '1.0.0';

app.get('/', (req, res) => {
  res.json({
    message: 'Health-aware deployment sample app',
    version: VERSION
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/ready', (req, res) => {
  res.status(200).json({ status: 'ready' });
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