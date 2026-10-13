import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import { runPoll } from '../src/jobs/poll.js';
import { evaluate } from '../src/jobs/process-invoice.js';
import { normalizeCustomer, normalizeInvoice } from '../src/mydata/normalize.js';
import { clampUpdatedAfter } from '../src/storeganise-api.js';
import { fakeStoreganise, freshDb, privateCustomer, sgInvoice, testConfig } from './helpers.js';

/**
 * Response shapes seen on a real Storeganise instance (dev-qodic, 2026-10-13).
 */

let pg;
beforeEach(async () => {
  pg = await freshDb();
});

test('valet invoices: lines come in `items` while `entries` is empty', () => {
  const raw = {
    id: 'v1', type: 'valet', state: 'paid', total: 9, balance: 0, taxPercent: null,
    entries: [],
    items: [{ id: 'i1', desc: 'Rent', quantity: 1, price: 9, startDate: '2026-09-23', total: 9 }],
  };
  const invoice = normalizeInvoice(raw);
  assert.equal(invoice.lines.length, 1);
  assert.equal(invoice.lines[0].description, 'Rent');
  assert.equal(invoice.lines[0].netCents, 900);

  // Unit invoices: `entries` wins, `items` ([] there) is ignored
  const unit = normalizeInvoice(sgInvoice({ items: [] }));
  assert.equal(unit.lines.length, 1);
});

test('list items carry owner as { id, name }', () => {
  const invoice = normalizeInvoice({ id: 'x', total: 1, owner: { id: 'u1', name: 'A B' } });
  assert.equal(invoice.ownerId, 'u1');
});

test('a €0 invoice is skipped before mapping, even with an unmappable line', async () => {
  const cfg = await testConfig();
  const raw = sgInvoice({
    type: 'valet', total: 0, subtotal: 0, tax: 0, balance: 0, entries: [],
    items: [{ desc: 'Rent', quantity: 1, price: 9, total: 9 }, { desc: 'Credit', quantity: 1, price: -9, total: -9 }],
    owner: privateCustomer(),
  });
  const decision = evaluate(normalizeInvoice(raw, cfg.settings), normalizeCustomer(raw.owner), cfg);
  assert.equal(decision.status, 'skipped');
  assert.equal(decision.reason, 'Zero-value invoice');
});

test('updatedAfter is never older than Storeganise allows (40 days); the poll records the gap', async () => {
  const old = new Date(Date.now() - 90 * 86400000);
  const clamped = clampUpdatedAfter(old);
  assert.ok(Date.now() - clamped.getTime() < 40 * 86400000);
  const recent = new Date(Date.now() - 3600000);
  assert.equal(clampUpdatedAfter(recent).getTime(), recent.getTime());

  // A cursor left 60 days behind (e.g. a long outage)
  await pg.query(`insert into einvoice.runtime_state (key, value) values ('poll_cursor:propco', $1)`,
    [JSON.stringify(new Date(Date.now() - 60 * 86400000).toISOString())]);
  const sg = fakeStoreganise({ 'inv-1': sgInvoice() });
  const seenAfter = [];
  const list = sg.listInvoices.bind(sg);
  sg.listInvoices = async params => { seenAfter.push(params.updatedAfter); return list(params); };

  const result = await runPoll({ sg });
  assert.ok(Date.now() - new Date(seenAfter[0]).getTime() < 40 * 86400000);
  assert.ok(result.accounts.propco.gapBefore);
  const { rows } = await pg.query(`select error from einvoice.audit_log where method = 'poll'`);
  assert.match(rows[0].error, /40-day updatedAfter limit/);
});
