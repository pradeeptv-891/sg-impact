import express from 'express';

import config from './config.js';
import handleWebhook from './main.js';
import { mountJobRoutes, startInProcessScheduler } from './src/jobs/scheduler.js';

const app = express();

// Keep the raw bytes. Storeganise signs the exact string it sends, and
// re-serialising the parsed body is not guaranteed to reproduce it.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/webhook', handleWebhook);

// pg_cron → pg_net → here (worker, poll, reconcile)
mountJobRoutes(app);

app.listen(config.port, () => {
  console.log(`Add-on listening on port ${config.port}`);
  if (config.inProcessScheduler) startInProcessScheduler();
});
