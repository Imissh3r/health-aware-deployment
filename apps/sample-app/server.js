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

app.listen(PORT, () => {
  console.log(`App version ${VERSION} listening on port ${PORT}`);
});