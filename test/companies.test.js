import assert from 'node:assert/strict';
import crypto from 'crypto';
import { beforeEach, test } from 'node:test';

import handleWebhook, { setStoreganiseClient } from '../main.js';
import { runPoll } from '../src/jobs/poll.js';
import { runWorker } from '../src/jobs/worker.js';
import { clearSecretCache } from '../src/secrets.js';
import { clearConfigCache } from '../src/settings.js';
import { StoreganiseError } from '../src/storeganise-api.js';
import { addCompany, companyId, fakeImpact, fakeStoreganise, freshDb, sgInvoice, unpaidInvoice } from './helpers.js';

/**
 * Multi-company, Storeganise side (scope §10): per-company webhook URL and secret,
 * per-company clients and poll cursors, site routing on a shared account, and
 * per-company pause.
 */

let pg;
let propco;
let clients;

beforeEach(async () => {
  pg = await freshDb();
  await pg.exec(`create function einvoice.get_secret(p_name text) returns text language sql as $$
    select case p_name
      when 'sg_propco_webhook_secret' then 'secret-propco'
      when 'sg_beta_webhook_secret'   then 'secret-beta'
      when 'sg_shared_webhook_secret' then 'secret-shared'
    end $$`);
  clearSecretCache();
  propco = await companyId(pg);
  clients = {};
  // Each company reads its own Storeganise account
  setStoreganiseClient(company => (clients[company.code] ||= fakeStoreganise()));
});

const sgFor = company => (clients[company.code] ||= fakeStoreganise());

async function deliver(code, body, secret) {
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
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
  };
  await handleWebhook(req, res);
  return res;
}

const paidEvent = (invoiceId = 'inv-1', businessCode) => ({
  id: crypto.randomUUID(), type: 'invoice.payments.updated', businessCode, data: { invoiceId, addedIds: ['p1'] },
});

async function jobs() {
  return (await pg.query(
    `select j.*, c.code as company from einvoice.jobs j join einvoice.companies c on c.id = j.company_id
      order by c.code, j.sg_invoice_id`,
  )).rows;
}

async function siteMode() {
  const url = 'https://shared.storeganise.com/api';
  const shared = await addCompany(pg, 'shared', { routing_mode: 'site', sg_api_url: url, sg_business_code: 'shared' });
  const north = await addCompany(pg, 'north', { routing_mode: 'site', sg_api_url: url, sg_business_code: 'shared' });
  await pg.query(
    `insert into einvoice.company_sites (sg_site_id, company_id) values ('site-s', $1), ('site-n', $2)`,
    [shared.id, north.id],
  );
  clearConfigCache();
  return { shared, north };
}

test('unknown or inactive company → 404, nothing read', async () => {
  const unknown = await deliver('nobody', paidEvent(), 'secret-propco');
  assert.equal(unknown.statusCode, 404);

  await pg.query(`update einvoice.companies set active = false where code = 'propco'`);
  clearConfigCache();
  const inactive = await deliver('propco', paidEvent(), 'secret-propco');
  assert.equal(inactive.statusCode, 404);

  assert.equal((await jobs()).length, 0);
  assert.deepEqual(clients, {});
});

test("company B's signature is refused on company A's URL; each webhook uses its own account (acceptance 12)", async () => {
  await addCompany(pg, 'beta');
  clients.propco = fakeStoreganise({ 'inv-1': sgInvoice() });
  clients.beta = fakeStoreganise({ 'inv-1': sgInvoice({ total: 248, subtotal: 200, tax: 48 }) });

  const crossed = await deliver('propco', paidEvent('inv-1', 'acme'), 'secret-beta');
  assert.equal(crossed.statusCode, 400);
  assert.equal(clients.propco.reads, 0);

  // The same Storeganise invoice id in two accounts is two separate invoices (FR-CAP-02)
  const a = await deliver('propco', paidEvent('inv-1', 'acme'), 'secret-propco');
  const b = await deliver('beta', paidEvent('inv-1', 'beta'), 'secret-beta');
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.notEqual(a.payload.jobId, b.payload.jobId);
  assert.equal(clients.propco.reads, 1);
  assert.equal(clients.beta.reads, 1);

  assert.deepEqual((await jobs()).map(j => [j.company, j.sg_invoice_id]), [['beta', 'inv-1'], ['propco', 'inv-1']]);

  // Another company's business code on this company's URL is refused too
  const wrongBusiness = await deliver('propco', paidEvent('inv-1', 'beta'), 'secret-propco');
  assert.equal(wrongBusiness.statusCode, 400);

  // Every webhook audit row carries its company
  const { rows } = await pg.query(`select company_id from einvoice.audit_log where kind = 'webhook' and status_code = 200`);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.company_id));
});

test('site mode: the invoice site decides the company; unmapped site → failed job, never sent', async () => {
  const { north } = await siteMode();
  clients.shared = fakeStoreganise({
    'inv-n': sgInvoice({ id: 'inv-n', siteId: 'site-n' }),
    'inv-x': sgInvoice({ id: 'inv-x', siteId: 'site-x' }),
    'inv-u': unpaidInvoice({ id: 'inv-u', siteId: 'site-x' }),
  });

  const routed = await deliver('shared', paidEvent('inv-n', 'shared'), 'secret-shared');
  assert.equal(routed.payload.queued, true);
  assert.equal(routed.payload.companyId, north.id);

  const unmapped = await deliver('shared', paidEvent('inv-x', 'shared'), 'secret-shared');
  assert.equal(unmapped.statusCode, 200);
  assert.equal(unmapped.payload.failed, 'unmapped site');

  // Unpaid: no job, whatever the site
  const unpaid = await deliver('shared', paidEvent('inv-u', 'shared'), 'secret-shared');
  assert.equal(unpaid.payload.ignored, 'not fully paid');

  const rows = await jobs();
  assert.deepEqual(rows.map(j => [j.company, j.sg_invoice_id, j.status]), [
    ['north', 'inv-n', 'new'],
    ['shared', 'inv-x', 'failed'],
  ]);
  assert.match(rows[1].last_error, /Unmapped site site-x/);

  // A later event for the north invoice on the shared URL finds north's job
  const again = await deliver('shared', paidEvent('inv-n', 'shared'), 'secret-shared');
  assert.equal(again.payload.jobId, routed.payload.jobId);

  // The worker sends north's invoice and never the unmapped one
  const impact = fakeImpact();
  await runWorker({ sgFor: () => clients.shared, impact });
  assert.equal(impact.sent.length, 1);
  assert.equal(JSON.stringify(impact.sent[0]).includes('"InternalDocumentId":"inv-n"'), true);
  assert.equal((await jobs()).find(j => j.sg_invoice_id === 'inv-x').status, 'failed');

  // Map the site, reroute: a new job under the right company, which is then sent
  await pg.query(`insert into einvoice.company_sites (sg_site_id, company_id) values ('site-x', $1)`, [north.id]);
  clearConfigCache();
  await pg.query(`select einvoice.reroute_unmapped_job($1)`, [rows[1].id]);
  await runWorker({ sgFor: () => clients.shared, impact });
  assert.equal(impact.sent.length, 2);
  const after = await jobs();
  assert.deepEqual(after.map(j => [j.company, j.sg_invoice_id, j.status]), [
    ['north', 'inv-n', 'sent'],
    ['north', 'inv-x', 'sent'],
  ]);
});

test("worker refuses a site-mode job whose site belongs to another company (isolation guard)", async () => {
  const { shared, north } = await siteMode();
  clients.shared = fakeStoreganise({ 'inv-n': sgInvoice({ id: 'inv-n', siteId: 'site-n' }) });

  // e.g. queued by an operator under the wrong company
  await pg.query(`select einvoice.enqueue_invoice($1, 'inv-n', 'operator.refresh')`, [shared.id]);
  const impact = fakeImpact();
  await runWorker({ sgFor: () => clients.shared, impact });

  assert.equal(impact.sent.length, 0);
  const [job] = await jobs();
  assert.equal(job.status, 'failed');
  assert.equal(job.number, null);
  assert.match(job.last_error, /belongs to company north/);
  assert.ok(north);
});

test('poll runs per account with its own cursor; one account failing does not stop the others (FR-CAP-04)', async () => {
  await addCompany(pg, 'beta');
  clients.propco = fakeStoreganise({ 'inv-1': sgInvoice(), 'inv-2': unpaidInvoice({ id: 'inv-2' }) });
  clients.beta = fakeStoreganise({ 'inv-9': sgInvoice({ id: 'inv-9' }) });

  const first = await runPoll({ sgFor });
  assert.equal(first.queued, 2);
  assert.equal(first.accounts.propco.queued, 1);
  assert.equal(first.accounts.beta.queued, 1);
  assert.deepEqual((await jobs()).map(j => [j.company, j.sg_invoice_id]), [['beta', 'inv-9'], ['propco', 'inv-1']]);

  const { rows: cursors } = await pg.query(`select key from einvoice.runtime_state where key like 'poll_cursor:%' order by key`);
  assert.deepEqual(cursors.map(r => r.key), ['poll_cursor:beta', 'poll_cursor:propco']);

  // Beta's Storeganise is down: propco is still polled, beta's cursor stays put
  const before = (await pg.query(`select value from einvoice.runtime_state where key = 'poll_cursor:beta'`)).rows[0].value;
  clients.beta.listInvoices = async () => { throw new StoreganiseError('Storeganise unreachable', { permanent: false }); };
  clients.propco.store.set('inv-3', sgInvoice({ id: 'inv-3' }));

  const second = await runPoll({ sgFor });
  assert.match(second.accounts.beta.error, /unreachable/);
  assert.ok((await jobs()).some(j => j.company === 'propco' && j.sg_invoice_id === 'inv-3'));
  const afterCursor = (await pg.query(`select value from einvoice.runtime_state where key = 'poll_cursor:beta'`)).rows[0].value;
  assert.equal(afterCursor, before);
});

test('poll on a shared account routes by site, once for the whole account', async () => {
  await siteMode();
  clients.shared = fakeStoreganise({
    'inv-s': sgInvoice({ id: 'inv-s', siteId: 'site-s' }),
    'inv-n': sgInvoice({ id: 'inv-n', siteId: 'site-n' }),
  });
  // Same account, so the same Storeganise data whichever company's credentials are used
  clients.north = clients.shared;
  // Propco has its own (empty) account
  clients.propco = fakeStoreganise();

  const result = await runPoll({ sgFor });
  assert.deepEqual(Object.keys(result.accounts).sort(), ['north', 'propco'], 'one poll per account, owner = first code');
  assert.deepEqual((await jobs()).map(j => [j.company, j.sg_invoice_id]), [['north', 'inv-n'], ['shared', 'inv-s']]);
});

test('pausing one company stops only that company (acceptance 11)', async () => {
  const beta = await addCompany(pg, 'beta');
  clients.propco = fakeStoreganise({ 'inv-1': sgInvoice() });
  clients.beta = fakeStoreganise({ 'inv-9': sgInvoice({ id: 'inv-9' }) });

  await pg.query(`select einvoice.set_company_paused('propco', true)`);
  await pg.query(`select einvoice.enqueue_invoice($1, 'inv-1', 'test')`, [propco]);
  await pg.query(`select einvoice.enqueue_invoice($1, 'inv-9', 'test')`, [beta.id]);

  const impact = fakeImpact();
  await runWorker({ sgFor, impact });
  assert.equal(impact.sent.length, 1);
  assert.deepEqual((await jobs()).map(j => [j.company, j.status]), [['beta', 'sent'], ['propco', 'pending']]);

  await pg.query(`select einvoice.set_company_paused('propco', false)`);
  await runWorker({ sgFor, impact });
  assert.deepEqual((await jobs()).map(j => [j.company, j.status]), [['beta', 'sent'], ['propco', 'sent']]);
});

test("a job's company never changes", async () => {
  const beta = await addCompany(pg, 'beta');
  const { rows: [{ id }] } = await pg.query(`select einvoice.enqueue_invoice($1, 'inv-1', 'test') as id`, [propco]);
  await assert.rejects(pg.query(`update einvoice.jobs set company_id = $1 where id = $2`, [beta.id, id]), /cannot change/);
});
