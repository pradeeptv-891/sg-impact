import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import * as repo from '../src/jobs/repo.js';
import { runPoll } from '../src/jobs/poll.js';
import { runReconciliation } from '../src/jobs/reconcile.js';
import { runWorker } from '../src/jobs/worker.js';
import { companyId, entry, fakeImpact, fakeStoreganise, freshDb, privateCustomer, setSetting, sgInvoice, unpaidInvoice } from './helpers.js';

let pg;
let propco;

beforeEach(async () => {
  pg = await freshDb();
  propco = await companyId(pg);
});

async function job(sgInvoiceId = 'inv-1', kind = 'invoice') {
  const { rows } = await pg.query(
    `select * from einvoice.jobs where sg_invoice_id = $1 and kind = $2 order by created_at`,
    [sgInvoiceId, kind],
  );
  return kind === 'invoice' ? rows[0] : rows;
}

/** Makes every retry due now, as if the backoff had elapsed. */
async function elapse() {
  await pg.query(`update einvoice.jobs set next_attempt_at = now() - interval '1 second'`);
}

test('happy path: webhook → job → number → Impact 201 → sent + write-back (FR-TX-05)', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact();

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated', 'site-1');
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated', 'site-1'); // duplicate delivery
  const summary = await runWorker({ sg, impact });

  assert.equal(summary.claimed, 1);
  assert.equal(impact.sent.length, 1);
  const j = await job();
  assert.equal(j.status, 'sent');
  assert.equal(j.series_code, 'TPY');
  assert.equal(Number(j.number), 1);
  assert.ok(j.mark);
  assert.equal(Number(j.amount_gross), 124);
  assert.equal(j.locked_until, null);

  const fields = sg.store.get('inv-1').customFields;
  assert.equal(fields.ei_status, 'sent');
  assert.equal(fields.ei_mark, j.mark);
  assert.equal(fields.ei_series, 'TPY');
  assert.equal(fields.ei_number, '1');
  assert.equal(fields.ei_error, '');

  // Nothing more to do: a second run sends nothing and writes nothing
  const writes = sg.writes.length;
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.payments.updated');
  await runWorker({ sg, impact });
  assert.equal(impact.sent.length, 1);
  assert.equal(sg.writes.length, writes);
});

test('worker never sends an invoice that is not fully paid, B2B or B2C, and uses no number (FR-CAP-03/05)', async () => {
  // Jobs only exist for paid invoices, but a payment can be reversed before the worker runs
  const sg = fakeStoreganise({
    'inv-1': unpaidInvoice({ state: 'draft' }),
    'inv-2': unpaidInvoice({ id: 'inv-2' }),
    'inv-3': unpaidInvoice({ id: 'inv-3', owner: privateCustomer(), balance: 24, payments: [{ id: 'p1', method: 'card', amount: 100 }] }),
  });
  const impact = fakeImpact();

  for (const id of ['inv-1', 'inv-2', 'inv-3']) await repo.enqueueInvoice(propco, id, 'invoice.payments.updated');
  await runWorker({ sg, impact });

  for (const id of ['inv-1', 'inv-2', 'inv-3']) {
    const j = await job(id);
    assert.equal(j.status, 'skipped', id);
    assert.equal(j.number, null, id);
    assert.match(j.status_reason, /^Not fully paid/, id);
  }
  assert.match((await job('inv-3')).status_reason, /balance €24\.00/);
  assert.equal(impact.sent.length, 0);

  // Paid → the B2B invoice and the B2C receipt go out, with the actual payment method
  Object.assign(sg.store.get('inv-2'), { state: 'paid', balance: 0, payments: [{ id: 'p1', method: 'bank', amount: 124 }] });
  Object.assign(sg.store.get('inv-3'), {
    state: 'paid', balance: 0, payments: [{ id: 'p1', method: 'card', amount: 100 }, { id: 'p2', method: 'card', amount: 24 }],
  });
  await repo.enqueueInvoice(propco, 'inv-2', 'invoice.payments.updated');
  await repo.enqueueInvoice(propco, 'inv-3', 'invoice.payments.updated');
  await runWorker({ sg, impact });

  assert.equal((await job('inv-2')).status, 'sent');
  const receipt = await job('inv-3');
  assert.equal(receipt.status, 'sent');
  assert.equal(receipt.series_code, 'APY');
  const byType = Object.fromEntries(impact.sent.map(d => [d.InvoiceTypeCode, d]));
  assert.equal(byType['2.1'].PaymentDetails.PaymentMethods[0].PaymentMethodTypeCode, 1);
  assert.equal(byType['11.2'].PaymentDetails.PaymentMethods[0].PaymentMethodTypeCode, 7);
  assert.equal(byType['11.2'].PaymentDetails.PaymentMethods[0].Amount, 124);
});

test('business customer with bad tax data is held, not sent as B2C, and uses no number (FR-CUS-02)', async () => {
  const invoice = sgInvoice();
  invoice.owner.customFields.ei_afm = '';
  const sg = fakeStoreganise({ 'inv-1': invoice });
  const impact = fakeImpact();

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  let j = await job();
  assert.equal(j.status, 'held');
  assert.equal(j.number, null);
  assert.equal(sg.store.get('inv-1').customFields.ei_status, 'held');
  assert.equal(sg.store.get('inv-1').customFields.ei_error, 'Customer ΑΦΜ missing');
  assert.equal(impact.sent.length, 0);

  // Staff fix the customer; the hourly re-check picks it up
  sg.store.get('inv-1').owner.customFields.ei_afm = '094014201';
  await elapse();
  await runWorker({ sg, impact });
  j = await job();
  assert.equal(j.status, 'sent');
  assert.equal(Number(j.number), 1);
  assert.equal(sg.store.get('inv-1').customFields.ei_error, '');
});

test('400 → failed_data, no auto retry; operator re-queue re-sends with the same number (FR-TX-03, FR-REC-03)', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice(), 'inv-2': sgInvoice({ id: 'inv-2' }) });
  const impact = fakeImpact({
    responses: [{ status: 400, body: { errors: { 'counterParty.address.postal': ['Postal code is invalid'] } } }],
  });

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  let j = await job();
  assert.equal(j.status, 'failed_data');
  assert.equal(Number(j.number), 1);
  assert.match(sg.store.get('inv-1').customFields.ei_error, /^Customer postal code invalid or missing/);
  assert.equal(sg.store.get('inv-1').customFields.ei_status, 'failed – data');

  // Events and time do not resend it
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.payments.updated');
  await elapse();
  await runWorker({ sg, impact });
  assert.equal(impact.sent.length, 1);

  // A later invoice takes the next number meanwhile
  await repo.enqueueInvoice(propco, 'inv-2', 'invoice.state.updated');
  await runWorker({ sg, impact });
  assert.equal(Number((await job('inv-2')).number), 2);

  await pg.query(`select einvoice.requeue_job($1, 'postcode fixed')`, [j.id]);
  await runWorker({ sg, impact });
  j = await job();
  assert.equal(j.status, 'sent');
  assert.equal(Number(j.number), 1, 'same number reused');
  assert.equal(impact.sent[2].Number, '1');

  const { rows: [series] } = await pg.query(`select * from einvoice.v_series where code = 'TPY'`);
  assert.equal(series.gaps, null);
  assert.equal(Number(series.issued), 2);
});

test('pre-send validation failure consumes no number (FR-MAP-07)', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice({ total: 999 }) });
  const impact = fakeImpact();

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  const j = await job();
  assert.equal(j.status, 'failed_data');
  assert.equal(j.number, null);
  assert.match(j.last_error, /Totals differ/);
  assert.equal(impact.sent.length, 0);
});

test('5xx and timeouts retry with backoff on the same number, then fail (FR-TX-04)', async () => {
  await setSetting(pg, 'retry_max_attempts', 3);
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact({ responses: [{ status: 503, body: null }, { status: null, error: 'timeout', body: null }, { status: 502, body: null }] });

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  let j = await job();
  assert.equal(j.status, 'retry');
  assert.equal(j.attempts, 1);
  assert.ok(new Date(j.next_attempt_at) > new Date(Date.now() + 300 * 1000));
  assert.equal(sg.store.get('inv-1').customFields.ei_status, 'retry');

  // Not due yet: nothing is sent
  await runWorker({ sg, impact });
  assert.equal(impact.sent.length, 1);

  await elapse();
  await runWorker({ sg, impact });
  await elapse();
  await runWorker({ sg, impact });

  j = await job();
  assert.equal(j.status, 'failed');
  assert.equal(j.attempts, 3);
  assert.deepEqual(impact.sent.map(p => p.Number), ['1', '1', '1']);
  assert.match(sg.store.get('inv-1').customFields.ei_error, /gave up after 3 attempts/);
  assert.match(sg.store.get('inv-1').customFields.ei_error, /^Impact unreachable \(timeout\)|^Impact unavailable \(HTTP 502\)/);
});

test('409 after a lost response: treated as success, identifiers recovered (FR-TX-03)', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  // First call lands at Impact but we only see a timeout; the retry gets 409
  const impact = fakeImpact({ responses: [{ acceptAnd: { status: 504, body: null } }, { status: 409, body: { message: 'already submitted' } }] });

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });
  assert.equal((await job()).status, 'retry');

  await elapse();
  await runWorker({ sg, impact });

  const j = await job();
  assert.equal(j.status, 'sent');
  assert.equal(j.mark, String(impact.docs[0].mark));
  assert.match(j.status_reason, /409/);
  assert.equal(impact.docs.length, 1, 'still exactly one document at Impact');
});

test('409 with Impact\'s SignatureResponse: identifiers taken straight from the body', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact({ responses: [{ acceptAnd: { status: 408, body: { success: false } } }, { duplicateOf: 0 }] });

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });
  let j = await job();
  assert.equal(j.status, 'retry');
  assert.match(j.last_error, /^AADE unreachable or document still processing \(HTTP 408\)/);

  await elapse();
  await runWorker({ sg, impact });
  j = await job();
  assert.equal(j.status, 'sent');
  assert.equal(j.mark, String(impact.docs[0].mark));
  assert.equal(j.auth_code, impact.docs[0].authenticationCode);
});

test('201 PENDING (sign policy DEFAULT): sent, MARK followed up until AADE assigns it', async () => {
  await setSetting(pg, 'impact_sign_policy', 0);
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact({ responses: [{ pending: true }] });

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  let j = await job();
  assert.equal(impact.sent[0].IAPRSignPolicy, 0);
  assert.equal(j.status, 'sent');
  assert.equal(j.impact_status, 'PENDING');
  assert.equal(j.mark, null);
  assert.equal(sg.store.get('inv-1').customFields.ei_error, 'Accepted by Impact; MARK pending from AADE');

  // Not due yet
  await runWorker({ sg, impact });
  assert.equal((await job()).mark, null);

  // Due, but AADE has not answered: still pending, not resent
  await elapse();
  await runWorker({ sg, impact });
  assert.equal((await job()).mark, null);
  assert.equal(impact.sent.length, 1);

  impact.releasePending();
  await elapse();
  await runWorker({ sg, impact });
  j = await job();
  assert.equal(j.mark, String(impact.docs[0].mark));
  assert.equal(j.impact_status, 'SUBMITTED');
  assert.equal(sg.store.get('inv-1').customFields.ei_mark, j.mark);
  assert.equal(sg.store.get('inv-1').customFields.ei_error, '');
  assert.equal(impact.sent.length, 1);
});

test('201 with status INVALID (sign policy LOOSE) is a data failure, not a success', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact({
    responses: [{ status: 201, body: { success: true, status: 'INVALID', mark: null, message: 'Invalid classification for invoice type' } }],
  });

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  const j = await job();
  assert.equal(j.status, 'failed_data');
  assert.equal(j.impact_status, 'INVALID');
  assert.match(j.last_error, /^Income classification rejected/);
});

test('offline issuance: offline QR on outage, then the frozen document is sent with IsDelayedCode', async () => {
  await setSetting(pg, 'offline_qr_enabled', true);
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact({ responses: [{ status: 503, body: { success: false } }] });

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  let j = await job();
  assert.equal(j.status, 'retry');
  assert.equal(j.delayed_code, 1);
  assert.match(j.offline_qr_url, /^https:\/\/einvoiceportaluat\.impact\.gr\/TransmissionFailure\?IssuerTin=EL999645320&CustomerTin=EL094014201/);
  assert.match(j.offline_qr_url, /&TotalAmount=124&.*&InternalId=inv-1&Signature=[0-9a-f]{40}$/);
  assert.equal(sg.store.get('inv-1').customFields.ei_qr_url, j.offline_qr_url);
  assert.match(sg.store.get('inv-1').customFields.ei_error, /Issued offline \(Transmission Failure_1\)/);

  // Storeganise changes the invoice meanwhile: the offline document must not change
  Object.assign(sg.store.get('inv-1'), { subtotal: 90, tax: 21.6, total: 111.6, entries: [entry('rent', 'Changed', 90)] });
  await elapse();
  await runWorker({ sg, impact });

  j = await job();
  assert.equal(j.status, 'sent');
  assert.equal(impact.sent[1].IsDelayedCode, 1);
  assert.equal(impact.sent[1].Summaries.TotalGrossValue, 124);
  assert.deepEqual({ ...impact.sent[1], IsDelayedCode: 0 }, impact.sent[0]);
  assert.equal(j.qr_url, impact.docs[0].url, 'real QR replaces the offline one');

  // …and the later change in Storeganise is flagged, not re-sent
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });
  assert.equal((await job()).changed_after_issue, true);
  assert.equal(impact.sent.length, 2);
});

test('crash mid-send: the expired lease is reclaimed and resent under the same number', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact();

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  const [claimed] = await repo.claimJobs({ limit: 1, leaseSeconds: 300, transmit: true });
  await repo.reserveNumber(claimed.id, { series: 'TPY', invoiceTypeCode: '2.1', customerKind: 'b2b' });
  await pg.query(`update einvoice.jobs set status = 'sending', locked_until = now() - interval '1 second' where id = $1`, [claimed.id]);

  await runWorker({ sg, impact });
  const j = await job();
  assert.equal(j.status, 'sent');
  assert.equal(Number(j.number), 1);
});

test('kill switch: jobs queue while paused and go out on resume (FR-CFG-05)', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact();

  await pg.query(`select einvoice.set_paused(true)`);
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  const summary = await runWorker({ sg, impact });

  assert.equal(summary.paused, true);
  assert.equal((await job()).status, 'pending');
  assert.equal(impact.sent.length, 0);

  await pg.query(`select einvoice.set_paused(false)`);
  await runWorker({ sg, impact });
  assert.equal((await job()).status, 'sent');
});

test('a Storeganise credit note (negative total) is held, not sent as an invoice', async () => {
  const sg = fakeStoreganise({
    'cn-1': sgInvoice({ id: 'cn-1', subtotal: -100, tax: -24, total: -124, entries: [entry('rent', 'Refund of rent', -100)] }),
  });
  const impact = fakeImpact();

  await repo.enqueueInvoice(propco, 'cn-1', 'invoice.created');
  await runWorker({ sg, impact });

  const j = await job('cn-1');
  assert.equal(j.status, 'held');
  assert.match(j.last_error, /Storeganise credit note/);
  assert.equal(j.number, null);
  assert.equal(impact.sent.length, 0);
});

test('deleted before issue closes the job; zero-value and deposit-only invoices are skipped', async () => {
  const sg = fakeStoreganise({
    'inv-2': sgInvoice({ id: 'inv-2', subtotal: 0, tax: 0, total: 0, entries: [entry('rent', 'Free month', 0)] }),
    'inv-3': sgInvoice({ id: 'inv-3', subtotal: 50, tax: 0, total: 50, entries: [entry('deposit', 'Deposit', 50, { taxPct: 0 })] }),
  });
  const impact = fakeImpact();

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.deleted');
  await repo.enqueueInvoice(propco, 'inv-2', 'invoice.state.updated');
  await repo.enqueueInvoice(propco, 'inv-3', 'invoice.state.updated');
  await runWorker({ sg, impact });

  assert.equal((await job('inv-1')).status, 'skipped');
  assert.equal((await job('inv-2')).status_reason, 'Zero-value invoice');
  assert.match((await job('inv-3')).status_reason, /No reportable lines/);
  assert.equal(impact.sent.length, 0);
});

test('edited after issue: flagged, never re-sent (FR-COR-03)', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact();

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  Object.assign(sg.store.get('inv-1'), { subtotal: 90, tax: 21.6, total: 111.6, entries: [entry('rent', 'Unit A12 — October', 90)] });
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  const j = await job();
  assert.equal(j.status, 'sent');
  assert.equal(j.changed_after_issue, true);
  assert.equal(impact.sent.length, 1);
  assert.match(sg.store.get('inv-1').customFields.ei_error, /^Changed after issue/);
});

test('voided after issue with credit notes off: flagged "credit note required" (FR-COR-01 is TBC)', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact();

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });
  sg.store.get('inv-1').state = 'writtenOff';
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  const j = await job();
  assert.equal(j.status, 'sent');
  assert.match(j.credit_required, /voided in Storeganise after issue: credit note required/);
  assert.equal((await job('inv-1', 'credit_note')).length, 0);
  assert.match(sg.store.get('inv-1').customFields.ei_error, /credit note required/);
});

test('credit notes on: partial refund then void → 5.1 notes correlated to the MARK, original credited (FR-COR-01/02)', async () => {
  await setSetting(pg, 'credit_notes_enabled', true);
  await setSetting(pg, 'partial_credit_enabled', true);
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact();

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });
  const original = await job();

  // Partial refund of €31
  sg.store.get('inv-1').payments = [{ id: 'p1', type: 'payment', method: 'card', amount: 124 }, { id: 'r1', type: 'refund', amount: -31 }];
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.payments.updated');
  await runWorker({ sg, impact }); // creates the credit job
  await runWorker({ sg, impact }); // sends it

  let credits = await job('inv-1', 'credit_note');
  assert.equal(credits.length, 1);
  assert.equal(credits[0].status, 'sent');
  assert.equal(credits[0].series_code, 'PT');
  assert.equal(Number(credits[0].amount_gross), 31);
  const partial = impact.sent[1];
  assert.equal(partial.InvoiceTypeCode, '5.1');
  assert.deepEqual(partial.CorrelatedInvoices, [Number(original.mark)]);

  // The same refund seen again does nothing
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.payments.updated');
  await runWorker({ sg, impact });
  assert.equal((await job('inv-1', 'credit_note')).length, 1);

  // Then the invoice is deleted: credit the remaining €93
  sg.store.delete('inv-1');
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.deleted');
  await runWorker({ sg, impact });
  await runWorker({ sg, impact });

  credits = await job('inv-1', 'credit_note');
  assert.equal(credits.length, 2);
  assert.equal(Number(credits[1].amount_gross), 93);
  assert.equal(credits[1].credit_reason, 'deleted');
  assert.equal((await job()).status, 'credited');

  const { rows: [series] } = await pg.query(`select * from einvoice.v_series where code = 'PT'`);
  assert.equal(Number(series.next_number), 3);
});

test('number reserved, then invoice deleted before sending: still issued, then credited (FR-NUM-03)', async () => {
  await setSetting(pg, 'credit_notes_enabled', true);
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const impact = fakeImpact({ responses: [{ status: 503, body: null }] });

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });
  assert.equal((await job()).status, 'retry');

  sg.store.delete('inv-1');
  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.deleted');
  await elapse();
  await runWorker({ sg, impact }); // sends number 1 from the snapshot, queues the credit
  await runWorker({ sg, impact }); // sends the credit

  const j = await job();
  assert.equal(j.status, 'credited');
  assert.equal(Number(j.number), 1);
  assert.equal((await job('inv-1', 'credit_note'))[0].status, 'sent');
});

test('safety-net poll queues missed paid invoices once; unpaid and partly paid ignored (FR-CAP-04)', async () => {
  const sg = fakeStoreganise({
    'inv-1': sgInvoice(),
    'inv-2': unpaidInvoice({ id: 'inv-2', state: 'draft' }),
    'inv-3': unpaidInvoice({ id: 'inv-3' }),
    'inv-4': unpaidInvoice({ id: 'inv-4', balance: 24 }),
  });

  const first = await runPoll({ sg });
  assert.equal(first.queued, 1);
  assert.ok(await job('inv-1'));
  for (const id of ['inv-2', 'inv-3', 'inv-4']) assert.equal(await job(id), undefined, id);

  // Already covered by a webhook since its last update
  sg.store.get('inv-1').updated = new Date(Date.now() - 60000).toISOString();
  const second = await runPoll({ sg });
  assert.equal(second.queued, 0);
});

test('nightly reconciliation: finds missing jobs, unknown and duplicate documents, stale failures (FR-REC-01)', async () => {
  const sg = fakeStoreganise({ 'inv-1': sgInvoice(), 'inv-2': sgInvoice({ id: 'inv-2' }), 'inv-3': unpaidInvoice({ id: 'inv-3' }) });
  const impact = fakeImpact({ responses: ['accept'] });

  await repo.enqueueInvoice(propco, 'inv-1', 'invoice.state.updated');
  await runWorker({ sg, impact });

  // A document issued outside the add-on, and a duplicate of our series/number
  impact.docs.push({ mark: '999', series: 'XYZ', number: '5', totalAmount: 10 });
  impact.docs.push({ ...impact.docs[0], mark: '998' });

  const result = await runReconciliation({ sg, impact });
  assert.equal(result.issues.missing_job, 1, 'inv-2 had no job; unpaid inv-3 is not expected to have one');
  assert.equal(result.paid, 2);
  assert.equal(result.issues.unknown_in_impact, 1);
  assert.equal(result.issues.duplicate_in_impact, 1);
  assert.equal(result.issues.mismatch, undefined);
  assert.ok(await job('inv-2'), 'missing invoice was queued');

  const { rows } = await pg.query(`select issue from einvoice.v_open_reconciliation_issues`);
  assert.equal(rows.length, 3);
});
