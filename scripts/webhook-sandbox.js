// Local webhook endpoint for testing with a real Storeganise account (e.g. via ngrok).
//
//   SG_API_URL=https://<business>.storeganise.com/api \
//   SG_API_KEY=<admin api key> SG_WEBHOOK_SECRET=<webhook secret> \
//     npm run webhook-sandbox -- [--port 3000] [--ignore-vat]
//
//   ngrok http 3000      # then point the Storeganise webhook at
//                        # https://<ngrok-host>/sg-webhook/propco
//
// Serves the add-on's real webhook handler (signature check, business check, paid
// check, routing, job creation). After each queued event, the worker evaluates the
// job as it would in production. As with the probe (scripts/lib/sandbox.js):
// Storeganise is only read, write-backs are blocked and printed, Impact is never
// called, and the database is in memory and gone when the process stops.
//
// Only POST /sg-webhook/:code and GET /health are served, so nothing about the
// invoices can be read through the public tunnel.

process.env.NODE_ENV = 'test'; // keeps the add-on's own background worker (nudgeWorker) off

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};
const port = Number(opt('port')) || Number(process.env.PORT) || 3000;
const ignoreVat = Boolean(opt('ignore-vat'));

const { SG_API_URL: apiUrl, SG_API_KEY: apiKey, SG_WEBHOOK_SECRET: webhookSecret } = process.env;
if (!apiUrl || !apiKey || !webhookSecret) {
  console.error('Set SG_API_URL, SG_API_KEY (admin API key) and SG_WEBHOOK_SECRET (Main Settings → Developer → Webhooks).');
  process.exit(1);
}

// The business code is the first part of the host: https://<code>.storeganise.com/api
const businessCode = new URL(apiUrl).hostname.split('.')[0];

const { createSandbox } = await import('./lib/sandbox.js');
const { pg, sg, impact, blockedWrites, stats } = await createSandbox({ apiUrl, apiKey, businessCode, webhookSecret, ignoreVat });

const { default: express } = await import('express');
const { default: handleWebhook, setStoreganiseClient } = await import('../main.js');
const { runWorker } = await import('../src/jobs/worker.js');

setStoreganiseClient(() => sg);

const time = () => new Date().toISOString().slice(11, 19);
let worker = Promise.resolve();

async function evaluateQueued() {
  const before = blockedWrites.length;
  const { rows: [{ now: runStart }] } = await pg.query('select now()');
  for (let i = 0; i < 10; i++) {
    const out = await runWorker({ sg, impact });
    if (!out.claimed) break;
  }
  const { rows } = await pg.query(
    `select sg_invoice_id, status, coalesce(last_error, status_reason) as reason, customer_kind, updated_at
       from einvoice.jobs where updated_at >= $1 order by updated_at`,
    [runStart],
  );
  for (const j of rows) {
    const verdict = j.status === 'pending' ? 'WOULD BE SENT to Impact' : j.status;
    console.log(`         worker: ${j.sg_invoice_id} → ${verdict}${j.customer_kind ? ` (${j.customer_kind})` : ''}${j.reason ? ` – ${j.reason}` : ''}`);
  }
  for (const w of blockedWrites.slice(before)) {
    const shown = Object.fromEntries(Object.entries(w.fields).filter(([, v]) => v !== ''));
    console.log(`         write-back blocked: ${w.id} ${JSON.stringify(shown)}`);
  }
}

const app = express();
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

app.get('/health', (req, res) => res.json({ ok: true, sandbox: true }));

app.post('/sg-webhook/:code', async (req, res) => {
  const started = Date.now();
  const status = res.status.bind(res);
  let code = 200;
  let payload = null;
  res.status = c => { code = c; return status(c); };
  const json = res.json.bind(res);
  res.json = p => { payload = p; return json(p); };

  await handleWebhook(req, res);

  const { type, data } = req.body || {};
  console.log(`${time()}  ${code}  ${req.params.code}  ${type ?? '(no type)'}  ${JSON.stringify(data ?? {})}  ${Date.now() - started}ms`);
  console.log(`         → ${JSON.stringify(payload)}`);

  if (payload?.queued) worker = worker.then(evaluateQueued).catch(err => console.error('         worker error:', err.message));
});

app.use((req, res) => res.status(404).json({ message: 'Not found' }));

app.listen(port, () => {
  console.log(`\nWebhook sandbox on http://localhost:${port}  (Storeganise: ${apiUrl}, business ${businessCode})`);
  console.log(`Read-only: Storeganise writes blocked, Impact never called, in-memory database.${ignoreVat ? ' VAT rewritten to 24%.' : ''}`);
  console.log(`\nNext:  ngrok http ${port}`);
  console.log(`Then set the Storeganise webhook URL to https://<ngrok-host>/sg-webhook/propco`);
  console.log(`Events: invoice.state.updated, invoice.payments.updated, invoice.deleted, user.updated\n`);
});

process.on('SIGINT', () => {
  console.log(`\nStopped. Storeganise GET requests: ${stats.requests}, write-backs blocked: ${blockedWrites.length}.`);
  process.exit(0);
});
