import assert from 'node:assert/strict';
import crypto from 'crypto';
import { test } from 'node:test';

import { isValidSignature } from '../main.js';
import { classify } from '../src/impact-api.js';
import { cleanAfm, isValidAfm } from '../src/mydata/afm.js';
import { readableImpactError } from '../src/mydata/errors.js';
import { allocate, toCents } from '../src/mydata/money.js';
import { greekMobile, resolveMethod } from '../src/mydata/notify.js';
import { fingerprint, normalizeCustomer, normalizeInvoice } from '../src/mydata/normalize.js';
import { businessCustomerProblems } from '../src/mydata/rules.js';
import { backoffSeconds } from '../src/jobs/transmit.js';
import { fieldsFor } from '../src/jobs/writeback.js';
import { buildOfflineQr, compactDate, offlineQrSignature } from '../src/mydata/offline-qr.js';
import fs from 'fs';

import { businessCustomer, CUSTOMER_AFM, entry, sgInvoice } from './helpers.js';

test('ΑΦΜ checksum', () => {
  assert.equal(isValidAfm(CUSTOMER_AFM), true);
  assert.equal(isValidAfm(`EL${CUSTOMER_AFM}`), true);
  assert.equal(isValidAfm('EL 094 014 201'), true);
  assert.equal(isValidAfm('094014202'), false);
  assert.equal(isValidAfm('000000000'), false);
  assert.equal(isValidAfm('12345'), false);
  assert.equal(isValidAfm(null), false);
  assert.equal(cleanAfm('gr094014201'), '094014201');
});

test('money: cents and exact allocation', () => {
  assert.equal(toCents(1.005), 101);
  assert.equal(toCents(-2.675), -268);
  assert.equal(toCents('19.99'), 1999);
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(-1000, [3000, 1000]), [-750, -250]);
  const parts = allocate(-997, [123, 456, 789]);
  assert.equal(parts.reduce((a, b) => a + b, 0), -997);
});

test('normalize: line VAT, discounts, refunds, VAT-inclusive prices', () => {
  const settings = { sg_discount_line_types: ['discount'], sg_refund_payment_types: ['refund'] };
  const inv = normalizeInvoice(sgInvoice({
    entries: [entry('rent', 'Rent', 100), entry('discount', 'Promo', -10)],
    payments: [{ id: 'p1', type: 'payment', method: 'Stripe', amount: 111.6 }, { id: 'r1', type: 'refund', amount: -10 }],
  }), settings);

  assert.equal(inv.lines[0].netCents, 10000);
  assert.equal(inv.lines[0].vatCents, 2400);
  assert.equal(inv.lines[1].isDiscount, true);
  assert.equal(inv.payments[0].method, 'stripe');
  assert.equal(inv.payments[1].isRefund, true);

  // Lines without Storeganise's per-line figures fall back to computing VAT
  const incl = normalizeInvoice(sgInvoice({ entries: [{ code: 'rent', desc: 'Rent', qty: 1, amount: 124, taxPct: 24 }] }), { prices_include_tax: true });
  assert.equal(incl.lines[0].netCents, 10000);
  assert.equal(incl.lines[0].vatCents, 2400);

  const fraction = normalizeInvoice(sgInvoice({ taxPercent: 0.24, entries: [{ code: 'rent', desc: 'Rent', amount: 100 }] }), {});
  assert.equal(fraction.lines[0].vatRate, 24);
});

test('normalize: customer tax data from custom fields', () => {
  const c = normalizeCustomer(businessCustomer({ ei_afm: 'EL094014201', ei_is_business: 'Yes' }));
  assert.equal(c.isBusiness, true);
  assert.equal(c.afm, CUSTOMER_AFM);
  assert.equal(c.companyName, 'Example Trading ΑΕ');
  assert.equal(c.address.city, 'Αθήνα');
  assert.equal(c.address.country, 'GR');
  assert.deepEqual(businessCustomerProblems(c), []);

  const bad = normalizeCustomer(businessCustomer({ ei_afm: '123456789', ei_company_name: '' }));
  assert.deepEqual(businessCustomerProblems(bad), [
    'Customer ΑΦΜ 123456789 is invalid (checksum)',
    'Customer registered company name missing',
  ]);
});

test('fingerprint changes when amounts change, not when payments do', () => {
  const a = normalizeInvoice(sgInvoice(), {});
  const b = normalizeInvoice(sgInvoice({ payments: [{ id: 'p', amount: 124 }] }), {});
  const c = normalizeInvoice(sgInvoice({ entries: [entry('rent', 'Unit A12 — October', 90)], total: 111.6 }), {});
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
});

test('Impact status classification (FRD 5.3)', () => {
  assert.equal(classify(201), 'success');
  assert.equal(classify(409), 'duplicate');
  assert.equal(classify(400), 'invalid');
  assert.equal(classify(422), 'invalid');
  assert.equal(classify(401), 'transient');
  assert.equal(classify(408), 'transient');
  assert.equal(classify(503), 'transient');
  assert.equal(classify(null), 'transient');
});

test('retry backoff: 8 attempts spread over most of a day', () => {
  const settings = { retry_base_seconds: 340, retry_max_delay_seconds: 21600 };
  const delays = [1, 2, 3, 4, 5, 6, 7].map(n => backoffSeconds(n, settings));
  assert.deepEqual(delays, [340, 680, 1360, 2720, 5440, 10880, 21600]);
  const hours = delays.reduce((a, b) => a + b, 0) / 3600;
  assert.ok(hours > 11 && hours < 24, `${hours}h`);
});

test('readable Impact errors (FR-ERR-03)', () => {
  assert.match(
    readableImpactError({ errors: { 'counterParty.Vat': ['The VAT number is not valid'] } }, 400),
    /^Customer ΑΦΜ invalid or missing/,
  );
  assert.match(readableImpactError({ message: 'Invalid classification E3_561_009' }, 400), /^Income classification rejected/);
  // Impact's BadRequestResponse: AADE's own messages come first
  assert.equal(
    readableImpactError({
      success: false, message: 'ValidationError', errors: ['Document rejected'],
      myDataErrors: [{ key: 102, value: 'Vat number EL094014202 does not belong to active corporation' }],
    }, 400),
    'Customer ΑΦΜ invalid or missing — Vat number EL094014202 does not belong to active corporation',
  );
  assert.equal(readableImpactError(null, 400), 'Impact rejected the document (HTTP 400)');
});

test('webhook signature: base64 HMAC-SHA256 of the raw body', () => {
  const body = Buffer.from('{"type":"invoice.state.updated"}');
  const secret = 's3cret';
  const good = crypto.createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(isValidSignature(body, good, secret), true);
  assert.equal(isValidSignature(body, good.slice(1), secret), false);
  assert.equal(isValidSignature(body, good, 'other'), false);
  assert.equal(isValidSignature(body, undefined, secret), false);
});

test('write-back fields (FRD 5.7)', () => {
  const fields = fieldsFor({
    status: 'sent', invoice_type_code: '2.1', series_code: 'TPY', number: 42, mark: '4000', uid: 'U',
    auth_code: 'A', qr_url: 'https://q', sent_at: '2026-10-01T02:01:00Z', last_error: null,
  }, [{ mark: '5000' }]);
  assert.equal(fields.ei_status, 'sent');
  assert.equal(fields.ei_number, '42');
  assert.equal(fields.ei_credit_mark, '5000');
  assert.equal(fields.ei_error, '');
  assert.equal(fieldsFor({ status: 'failed_data', last_error: 'Customer ΑΦΜ missing' }).ei_status, 'failed – data');
});

test('offline QR signature and URL match Impact\'s worked example', () => {
  const apiKey = 'c0e4a18d-d3b4-40e6-92d0-ac96becb01c8';
  assert.equal(offlineQrSignature({
    issuerTin: 'EL036712001', customerTin: 'EL110099934', series: 'ΤΔΑ', number: '000028375',
    dateIssued: '20250621101302', totalAmount: '124', internalId: 'ΤΔΑ1.100002837520250621101302',
  }, apiKey), 'f08035d66842456df2411a1ca0e738ff10376e4a');

  const { url, signature } = buildOfflineQr({
    InvoiceTypeCode: '1.1', Series: 'ΤΔΑ', Number: '000028375', DateIssued: '2025-06-21T10:13:02',
    Issuer: { Vat: 'EL036712001' },
    CounterParty: { Vat: 'EL110099934', RegisteredName: 'Demo Company' },
    Summaries: { TotalGrossValue: 124, TotalNetAmount: 100, TotalVATAmount: 24 },
    DistributionDetails: { InternalDocumentId: 'ΤΔΑ1.100002837520250621101302' },
  }, { apiKey, portalUrl: 'https://einvoiceportaluat.impact.gr/' });

  assert.equal(signature, 'f08035d66842456df2411a1ca0e738ff10376e4a');
  assert.equal(url, 'https://einvoiceportaluat.impact.gr/TransmissionFailure?IssuerTin=EL036712001&CustomerTin=EL110099934'
    + '&CustomerName=Demo+Company&InvoiceType=1.1&Series=%CE%A4%CE%94%CE%91&Number=000028375&DateIssued=20250621101302'
    + '&TotalAmount=124&TotalNetAmount=100&TotalVatAmount=24&InternalId=%CE%A4%CE%94%CE%911.100002837520250621101302'
    + '&Signature=f08035d66842456df2411a1ca0e738ff10376e4a');
  assert.equal(compactDate('2026-10-01T05:00:00'), '20261001050000');
});

test('real Storeganise invoice: lines come from entries, with Storeganise\'s own net/VAT', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/sg-invoice.json', import.meta.url)));
  const inv = normalizeInvoice(raw, {});

  assert.equal(raw.items.length, 0, 'items is not the invoice lines');
  assert.equal(inv.lines.length, 1);
  assert.deepEqual(
    (({ type, accountingCode, description, quantity, vatRate, netCents, vatCents, grossCents, isDiscount }) =>
      ({ type, accountingCode, description, quantity, vatRate, netCents, vatCents, grossCents, isDiscount }))(inv.lines[0]),
    { type: 'revenue', accountingCode: 'rent', description: 'Rent', quantity: 1, vatRate: 8.25, netCents: 1000, vatCents: 83, grossCents: 1083, isDiscount: false },
  );
  assert.equal(inv.totalCents, 1083);
  assert.equal(inv.taxCents, 83);
  assert.equal(inv.balanceCents, 0);
  assert.equal(inv.state, 'failed');
  assert.equal(inv.siteId, '68c90a2bc81e01280b7cc74a');
  assert.equal(inv.creditNoteId, '69d781cf1b9415587197c9ee');
  assert.deepEqual(inv.payments, [{
    id: '69cb817604fc7f476d1c8592', type: 'manual', method: 'cheque', amountCents: 1083, date: '2026-03-31', isRefund: false,
  }]);

  const customer = normalizeCustomer(raw.owner);
  assert.equal(customer.name, 'Test Customer');
  assert.equal(customer.isBusiness, false);
  assert.equal(customer.address.street, 'Universe');
});

test('greekMobile: Impact\'s +3069XXXXXXXX format; landlines and foreign numbers rejected', () => {
  assert.equal(greekMobile('6912345678'), '+306912345678');
  assert.equal(greekMobile('+30 691 234 5678'), '+306912345678');
  assert.equal(greekMobile('0030-6912345678'), '+306912345678');
  assert.equal(greekMobile('306912345678'), '+306912345678');
  assert.equal(greekMobile('(+30) 69 1234 5678'), '+306912345678');
  assert.equal(greekMobile('2101234567'), null);
  assert.equal(greekMobile('+302101234567'), null);
  assert.equal(greekMobile('+447700900123'), null);
  assert.equal(greekMobile('69123'), null);
  assert.equal(greekMobile(null), null);
});

test('resolveMethod: each method falls back to the best the customer\'s contacts allow', () => {
  const cases = [
    // method, email, mobile → sent as
    ['C', true, true, 'C'], ['C', true, false, 'E'], ['C', false, true, 'M'], ['C', false, false, 'A'],
    ['M', true, true, 'M'], ['M', true, false, 'E'], ['M', false, false, 'A'],
    ['E', true, true, 'E'], ['E', false, true, 'A'],
    ['A', true, true, 'A'],
  ];
  for (const [method, email, mobile, expected] of cases) {
    assert.equal(resolveMethod(method, email, mobile), expected, `${method} email=${email} mobile=${mobile}`);
  }
});
