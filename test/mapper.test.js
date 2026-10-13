import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { buildDocument } from '../src/mydata/mapper.js';
import { buildCreditNote } from '../src/mydata/credit-note.js';
import { normalizeCustomer, normalizeInvoice } from '../src/mydata/normalize.js';
import { validateDocument } from '../src/mydata/validate.js';
import fs from 'fs';

import { businessCustomer, entry, freshDb, privateCustomer, sgInvoice, testConfig } from './helpers.js';

let cfg;

before(async () => {
  await freshDb();
  cfg = await testConfig();
});

function build(raw, { config = cfg, job = {}, numbering = { number: 7, dateIssued: '2026-10-01T02:00:00Z' } } = {}) {
  const invoice = normalizeInvoice(raw, config.settings);
  const customer = normalizeCustomer(raw.owner);
  return buildDocument({ invoice, customer, config, job, numbering });
}

test('B2B service invoice → 2.1 in the shape of Impact\'s official 2.1 sample', () => {
  const result = build(sgInvoice());
  assert.equal(result.ok, true, result.errors.join('; '));
  const p = result.payload;

  assert.deepEqual(Object.keys(p), [
    'IAPRSignPolicy', 'CurrencyCode', 'InvoiceType', 'InvoiceTypeCode', 'DocumentType', 'DocumentTypeCode',
    'Series', 'Number', 'DateIssued', 'Issuer', 'CounterParty', 'DistributionDetails', 'PaymentDetails',
    'AdditionalDetails', 'Details', 'Summaries', 'VatAnalysis', 'IsDelayedCode',
  ]);
  assert.equal(p.IAPRSignPolicy, 2);
  assert.equal(p.InvoiceType, 'Service Rendered Invoice');
  assert.equal(p.InvoiceTypeCode, '2.1');
  assert.equal(p.DocumentTypeCode, 'INVOICE');
  assert.equal(p.Series, 'TPY');
  assert.equal(p.Number, '7');
  assert.equal(p.DateIssued, '2026-10-01T05:00:00'); // Athens local time
  assert.equal(p.IsDelayedCode, 0);

  assert.deepEqual(p.Issuer, {
    RegisteredName: 'Storage Co ΙΚΕ',
    Vat: 'EL999645320',
    TaxOffice: 'ΔΟΥ Αθηνών',
    Address: { CountryCode: 'GR', City: 'Αθήνα', Street: 'Λεωφόρος Κηφισίας', Number: '10', Postal: '11526' },
    BranchCode: 0,
  });
  assert.deepEqual(p.CounterParty, {
    RegisteredName: 'Example Trading ΑΕ',
    Vat: 'EL094014201',
    TaxOffice: 'ΔΟΥ Α Αθηνών',
    Address: { CountryCode: 'GR', City: 'Αθήνα', Street: 'Ερμού 5', Postal: '10563' },
    Code: 'user-b2b',
  });
  assert.deepEqual(p.DistributionDetails, { InternalDocumentId: 'inv-1' });

  assert.deepEqual(p.Details, [{
    LineNo: 1,
    Code: 'rent',
    Descriptions: ['Unit A12 — October'],
    MeasurementUnitCode: 1,
    Quantity: 1,
    UnitPrice: 100,
    NetTotal: 100,
    VATTotal: 24,
    Total: 124,
    VatCategory: '24%',
    VatCategoryCode: 1,
    IsInformative: false,
    IsHidden: false,
    RecordTypeCode: 0,
    IncomeClassification: { ClassificationTypeCode: 'E3_561_001', ClassificationCategoryCode: 'category1_3', Amount: 100 },
  }]);
  assert.deepEqual(p.VatAnalysis, [{ Name: '24%', Percentage: 24, VatAmount: 24, UnderlyingValue: 100 }]);
  assert.equal(p.Summaries.TotalGrossValue, 124);
  assert.equal(p.Summaries.TotalPayableAmount, 124);
  // Paid by bank transfer → domestic payment account
  assert.deepEqual(p.PaymentDetails.PaymentMethods, [{ PaymentMethodType: 'Επαγ. Λογαριασμός Πληρωμών Ημεδαπής', PaymentMethodTypeCode: 1, Amount: 124 }]);
  // Archive only: Impact must not email anyone unless distribution is switched on
  assert.deepEqual(p.AdditionalDetails, { TransmissionMethod: 'A', AvoidEmailGrouping: false, AccountingDepartmentEmails: [''] });

  assert.deepEqual(validateDocument(p, { customerKind: 'b2b' }), []);
});

test('B2C receipt → 11.2, no counterparty, paid by card', () => {
  const result = build(sgInvoice({
    owner: privateCustomer(),
    state: 'paid',
    payments: [{ id: 'p1', type: 'payment', method: 'stripe', amount: 124 }],
  }));
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.payload.InvoiceTypeCode, '11.2');
  assert.equal(result.payload.Series, 'APY');
  assert.equal(result.payload.CounterParty, undefined);
  assert.equal(result.payload.Details[0].IncomeClassification.ClassificationTypeCode, 'E3_561_003');
  assert.deepEqual(result.payload.PaymentDetails.PaymentMethods.map(m => [m.PaymentMethodTypeCode, m.Amount]), [[7, 124]]);
  assert.deepEqual(validateDocument(result.payload, { customerKind: 'b2c' }), []);
});

test('distribution on: Impact emails the customer (TransmissionMethod E)', async () => {
  const withEmail = await testConfig({ distribution_enabled: true });
  const p = build(sgInvoice(), { config: withEmail }).payload;
  assert.deepEqual(p.AdditionalDetails, {
    TransmissionMethod: 'E', AvoidEmailGrouping: false, AccountingDepartmentEmails: ['accounts@example.gr'],
  });

  const owner = businessCustomer();
  delete owner.email;
  const noEmail = build(sgInvoice({ owner }), { config: withEmail }).payload;
  assert.equal(noEmail.AdditionalDetails.TransmissionMethod, 'A');
});

test('deposit excluded, goods line, discount allocated across same-rate lines', () => {
  const raw = sgInvoice({
    subtotal: 210, tax: 38.4, total: 248.4,
    entries: [
      entry('rent', 'Rent', 150),
      entry('padlock', 'Padlock', 10, { qty: 2, type: 'product' }),
      entry('discount', 'First month 20% off', -10),
      entry('deposit', 'Security deposit', 50, { taxPct: 0 }),
    ],
  });
  const result = build(raw);
  assert.equal(result.ok, true, result.errors.join('; '));
  const d = result.payload.Details;

  assert.equal(d.length, 2, 'deposit removed, discount folded in');
  assert.equal(result.meta.excludedGrossCents, 5000);
  // €10 discount split 150:20 → 8.82 / 1.18
  assert.equal(d[0].NetTotal, 141.18);
  assert.equal(d[1].NetTotal, 18.82);
  assert.equal(d[1].IncomeClassification.ClassificationCategoryCode, 'category1_1');
  assert.equal(result.payload.Summaries.TotalNetAmount, 160);
  assert.equal(result.payload.Summaries.TotalVATAmount, 38.4);
  assert.equal(result.payload.Summaries.TotalGrossValue, 198.4);
  assert.equal(result.meta.nature, 'mixed');
  assert.equal(result.payload.InvoiceTypeCode, '2.1');
  assert.deepEqual(validateDocument(result.payload, { customerKind: 'b2b' }), []);
});

test('deposit-only invoice has nothing to report', () => {
  const result = build(sgInvoice({ subtotal: 50, tax: 0, total: 50, entries: [entry('deposit', 'Deposit', 50, { taxPct: 0 })] }));
  assert.equal(result.ok, false);
  assert.equal(result.meta.noReportableLines, true);
});

test('Storeganise rounding VAT on the total is absorbed; a real mismatch blocks (FR-MAP-05)', () => {
  // Lines without per-line VAT: 0.80 + 0.80 + 0.80 = 2.40, but SG put 2.41 on the total
  const lines = [1, 2, 3].map(i => ({ code: 'rent', desc: `Line ${i}`, qty: 1, amount: 3.33, taxPct: 24 }));
  const ok = build(sgInvoice({ entries: lines, subtotal: 9.99, tax: 2.4, total: 12.39 }));
  assert.equal(ok.ok, true, ok.errors.join('; '));
  const rounded = build(sgInvoice({ entries: lines, subtotal: 9.99, tax: 2.41, total: 12.4 }));
  assert.equal(rounded.ok, true, rounded.errors.join('; '));
  assert.equal(rounded.payload.Summaries.TotalVATAmount, 2.41);

  const wrong = build(sgInvoice({ total: 130 }));
  assert.equal(wrong.ok, false);
  assert.match(wrong.errors.join(), /Totals differ from Storeganise: document €124.00 vs invoice €130.00/);
});

test('insurance mapped as "without VAT" (category 7) needs an exemption reason', () => {
  const raw = sgInvoice({
    tax: 24, total: 134,
    entries: [entry('rent', 'Rent', 100), entry('insurance', 'Protection', 10, { taxPct: 0 })],
  });
  assert.match(build(raw).errors.join(), /VAT exemption reason missing in mapping for "insurance" lines/);

  // With the accountant's exemption code (e.g. 27 "Other VAT exemptions") it goes through
  const withCode = structuredClone(cfg);
  withCode.lineMappings = cfg.lineMappings.map(m => (m.accounting_code === 'insurance' ? { ...m, vat_exemption_code: 27 } : m));
  const result = build(raw, { config: withCode });
  assert.equal(result.ok, true, result.errors.join('; '));
  const line = result.payload.Details[1];
  assert.equal(line.VatCategoryCode, 7);
  assert.equal(line.VatCategory, '0%');
  assert.equal(line.VatExemptionCategoryCode, 27);
  assert.equal(result.payload.VatAnalysis.length, 2);
  assert.deepEqual(validateDocument(result.payload, { customerKind: 'b2b' }), []);
});

test('EU business customer is not covered by the placeholder rules', () => {
  const owner = businessCustomer();
  owner.address.country = 'DE';
  const result = build(sgInvoice({ owner }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /No document-type rule for B2B customer in EU/);
});

test('production refuses placeholder (unapproved) mapping', async () => {
  const prod = await testConfig({ impact_env: 'production' });
  const result = build(sgInvoice(), { config: prod });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(), /Mapping not approved by accountant/);
});

test('credit notes: 5.1 with numeric CorrelatedInvoices, full copy or partial by VAT rate', () => {
  const original = build(sgInvoice()).payload;
  const originalJob = { mark: '400001825348483', sg_invoice_id: 'inv-1', customer_kind: 'b2b' };
  const rule = cfg.docTypeRules.find(r => r.kind === 'credit' && r.customer_kind === 'b2b');

  const full = buildCreditNote({ original, originalJob, rule, correctionKey: 'void', numbering: { series: 'PT', number: 1 } });
  assert.equal(full.ok, true);
  assert.equal(full.payload.InvoiceTypeCode, '5.1');
  assert.equal(full.payload.DocumentTypeCode, 'INVOICE');
  assert.deepEqual(full.payload.CorrelatedInvoices, [400001825348483]);
  assert.equal(full.payload.Summaries.TotalGrossValue, 124);
  assert.equal(full.payload.DistributionDetails.InternalDocumentId, 'inv-1:credit:void');
  assert.deepEqual(validateDocument(full.payload, { customerKind: 'b2b', isCredit: true }), []);

  const partial = buildCreditNote({ original, originalJob, rule, amountCents: 3100, correctionKey: 'refund:r1', reason: 'refund' });
  assert.equal(partial.ok, true);
  assert.equal(partial.payload.Summaries.TotalGrossValue, 31);
  assert.equal(partial.payload.Summaries.TotalNetAmount, 25);
  assert.equal(partial.payload.Summaries.TotalVATAmount, 6);
  assert.deepEqual(validateDocument(partial.payload, { customerKind: 'b2b', isCredit: true }), []);

  const noMark = { ...full.payload, CorrelatedInvoices: [] };
  assert.match(validateDocument(noMark, { customerKind: 'b2b', isCredit: true }).join(), /no original MARK/);

  const tooMuch = buildCreditNote({ original, originalJob, rule, amountCents: 20000, correctionKey: 'x' });
  assert.equal(tooMuch.ok, false);
});

test('real Storeganise invoice: 8.25% is not a Greek VAT rate, so it is blocked; at 24% it maps cleanly', () => {
  const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/sg-invoice.json', import.meta.url)));

  // As exported (a non-Greek test account): refused with a readable reason
  const asIs = build(raw);
  assert.equal(asIs.ok, false);
  assert.match(asIs.errors.join(), /Unsupported VAT rate 8.25% on line "Rent"/);

  // Same invoice with Greek VAT: a B2C receipt paid by cheque
  const greek = structuredClone(raw);
  Object.assign(greek.entries[0], { taxPct: 24, tax: 2.4, total: 12.4 });
  Object.assign(greek, { tax: 2.4, total: 12.4, amountPaid: 12.4 });
  greek.payments[0].amount = 12.4;
  const result = build(greek);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.payload.InvoiceTypeCode, '11.2');
  assert.equal(result.payload.DistributionDetails.InternalDocumentId, '69cb816904fc7f476d1c7b1b');
  assert.deepEqual(result.payload.Details[0], {
    LineNo: 1, Code: 'rent', Descriptions: ['Rent'], MeasurementUnitCode: 1, Quantity: 1, UnitPrice: 10, NetTotal: 10,
    VATTotal: 2.4, Total: 12.4, VatCategory: '24%', VatCategoryCode: 1, IsInformative: false, IsHidden: false,
    RecordTypeCode: 0, IncomeClassification: { ClassificationTypeCode: 'E3_561_003', ClassificationCategoryCode: 'category1_3', Amount: 10 },
  });
  assert.deepEqual(result.payload.PaymentDetails.PaymentMethods, [{ PaymentMethodType: 'Επιταγή', PaymentMethodTypeCode: 4, Amount: 12.4 }]);
  assert.deepEqual(validateDocument(result.payload, { customerKind: 'b2c' }), []);
});
