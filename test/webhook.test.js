import assert from 'node:assert/strict';
import crypto from 'crypto';
import { beforeEach, test } from 'node:test';

import handleWebhook, { setStoreganiseClient } from '../main.js';
import { clearSecretCache } from '../src/secrets.js';
import { StoreganiseError } from '../src/storeganise-api.js';
import { runWorker } from '../src/jobs/worker.js';
import { businessCustomer, fakeImpact, fakeStoreganise, freshDb, privateCustomer, sgInvoice, unpaidInvoice } from './helpers.js';

let pg;
let sg;

beforeEach(async () => {
  pg = await freshDb();
  await pg.exec(`create function einvoice.get_secret(p_name text) returns text language sql as $$
    select case p_name when 'sg_propco_webhook_secret' then 'whsec' end $$`);
  clearSecretCache();
  sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  setStoreganiseClient(sg);
});

async function jobs() {
  return (await pg.query(`select * from einvoice.jobs`)).rows;
}

async function deliver(body, { secret = 'whsec', code = 'propco' } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = {
    headers: { 'sg-signature': crypto.createHmac('sha256', secret).update(raw).digest('base64') },
    params: { code },
    rawBody: raw,
    body,
  };
  const res = {
    statusCode: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await handleWebhook(req, res);
  return res;
}

const event = (type, data = { invoiceId: 'inv-1', siteId: 'site-1', from: 'sent', to: 'paid' }) => ({
  id: crypto.randomUUID(),
  businessCode: 'acme',
  apiUrl: 'https://acme.storeganise.com/api',
  type,
  data,
});

test('paid invoice is queued once, however often its events arrive (FR-CAP-01/02)', async () => {
  const first = await deliver(event('invoice.state.updated'));
  const second = await deliver(event('invoice.payments.updated', { invoiceId: 'inv-1', addedIds: ['p1'] }));

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.payload.queued, true);
  assert.equal(first.payload.jobId, second.payload.jobId);

  const rows = await jobs();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].last_event, 'invoice.payments.updated');
  assert.equal(rows[0].needs_eval, true);
  assert.equal(rows[0].sg_site_id, 'site-1');

  const { rows: audit } = await pg.query(`select * from einvoice.audit_log where kind = 'webhook'`);
  assert.equal(audit.length, 2);
});

test('invoice.created is acknowledged and ignored: no job, Storeganise not even read (FRD v1.3)', async () => {
  const res = await deliver(event('invoice.created', { invoiceId: 'inv-1', siteId: 'site-1' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { ignored: 'invoice.created' });
  assert.equal(sg.reads, 0);
  assert.equal((await jobs()).length, 0);
});

test('unpaid and partly paid invoices get no job until fully paid, B2B and B2C alike (FR-CAP-03/05)', async () => {
  sg.store.set('inv-1', unpaidInvoice());
  sg.store.set('inv-2', unpaidInvoice({
    id: 'inv-2', owner: privateCustomer(), balance: 24, payments: [{ id: 'p1', type: 'payment', method: 'card', amount: 100 }],
  }));

  const unpaid = await deliver(event('invoice.state.updated', { invoiceId: 'inv-1', from: 'draft', to: 'sent' }));
  const partly = await deliver(event('invoice.payments.updated', { invoiceId: 'inv-2', addedIds: ['p1'] }));

  assert.equal(unpaid.statusCode, 200);
  assert.equal(unpaid.payload.ignored, 'not fully paid');
  assert.equal(partly.payload.ignored, 'not fully paid');
  assert.equal(partly.payload.balance, 24);
  assert.equal((await jobs()).length, 0);

  // The rest is paid: now the job exists
  Object.assign(sg.store.get('inv-2'), {
    state: 'paid', balance: 0,
    payments: [{ id: 'p1', type: 'payment', method: 'card', amount: 100 }, { id: 'p2', type: 'payment', method: 'card', amount: 24 }],
  });
  const paid = await deliver(event('invoice.payments.updated', { invoiceId: 'inv-2', addedIds: ['p2'] }));
  assert.equal(paid.payload.queued, true);
  assert.deepEqual((await jobs()).map(j => j.sg_invoice_id), ['inv-2']);
});

test('paid is read from the balance when the state is not "paid"', async () => {
  sg.store.set('inv-1', sgInvoice({ state: 'sent', balance: 0 }));
  const res = await deliver(event('invoice.payments.updated', { invoiceId: 'inv-1', addedIds: ['p1'] }));
  assert.equal(res.payload.queued, true);
});

test('invoice.deleted: ignored if never paid, flags the job if it was (FR-COR-01)', async () => {
  const never = await deliver(event('invoice.deleted', { invoiceId: 'inv-9' }));
  assert.equal(never.statusCode, 200);
  assert.equal(never.payload.ignored, 'invoice was never paid');
  assert.equal((await jobs()).length, 0);

  await deliver(event('invoice.payments.updated'));
  await pg.query(`update einvoice.jobs set needs_eval = false`);
  sg.store.delete('inv-1');
  const reads = sg.reads;

  const deleted = await deliver(event('invoice.deleted', { invoiceId: 'inv-1' }));
  assert.equal(deleted.payload.queued, true);
  assert.equal(sg.reads, reads, 'a tracked invoice is not read in the webhook; the worker does that');
  const [row] = await jobs();
  assert.equal(row.last_event, 'invoice.deleted');
  assert.equal(row.needs_eval, true);
});

test('Storeganise unreachable while checking payment → 500 so Storeganise retries; nothing queued', async () => {
  sg.getInvoice = async () => {
    throw new StoreganiseError('Storeganise unreachable: ECONNRESET', { permanent: false });
  };
  const res = await deliver(event('invoice.payments.updated'));
  assert.equal(res.statusCode, 500);
  assert.equal((await jobs()).length, 0);
});

test('bad signature → 400 (no retry), nothing read or queued', async () => {
  const res = await deliver(event('invoice.state.updated'), { secret: 'wrong' });
  assert.equal(res.statusCode, 400);
  assert.equal(sg.reads, 0);
  assert.equal((await jobs()).length, 0);
});

test('another business is refused; unknown events are acknowledged and ignored', async () => {
  const other = await deliver({ ...event('invoice.state.updated'), businessCode: 'someone-else' });
  assert.equal(other.statusCode, 400);

  const ignored = await deliver(event('unit.updated'));
  assert.equal(ignored.statusCode, 200);
  assert.deepEqual(ignored.payload, { ignored: 'unit.updated' });

  assert.equal((await jobs()).length, 0);
});

test('plain Storeganise webhook (no businessCode / apiUrl in the body) is accepted', async () => {
  const res = await deliver({ id: 'evt-1', created: new Date().toISOString(), type: 'invoice.payments.updated', data: { invoiceId: 'inv-1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.queued, true);
});

test('user.updated re-checks that customer\'s held invoices at once; sent once fixed (FR-CUS-02)', async () => {
  sg.store.set('inv-1', sgInvoice({ owner: businessCustomer({ ei_afm: '' }) }));
  await deliver(event('invoice.payments.updated'));

  const impact = fakeImpact();
  await runWorker({ sg, impact });
  let [job] = await jobs();
  assert.equal(job.status, 'held');
  assert.equal(job.sg_owner_id, 'user-b2b');
  assert.ok(new Date(job.next_attempt_at) > new Date(Date.now() + 30 * 60000), 'hourly re-check scheduled');

  // Another customer changing does nothing
  const other = await deliver(event('user.updated', { userId: 'someone-else' }));
  assert.equal(other.statusCode, 200);
  assert.equal(other.payload.recheck, 0);

  // Staff add the ΑΦΜ in Storeganise
  sg.store.get('inv-1').owner = businessCustomer();
  const reads = sg.reads;
  const fixed = await deliver(event('user.updated', { userId: 'user-b2b' }));
  assert.equal(fixed.payload.recheck, 1);
  assert.equal(sg.reads, reads, 'nothing is read from Storeganise in the webhook');

  await runWorker({ sg, impact });
  [job] = await jobs();
  assert.equal(job.status, 'sent');
  assert.equal(impact.sent.length, 1);
});
