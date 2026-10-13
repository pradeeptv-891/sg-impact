import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { PGlite } from '@electric-sql/pglite';

import { setDb } from '../src/db.js';
import { clearConfigCache, loadConfig } from '../src/settings.js';
import { classify } from '../src/impact-api.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrations = path.join(root, 'supabase', 'migrations');

export const ISSUER_AFM = '999645320';
export const CUSTOMER_AFM = '094014201';

/**
 * A fresh in-memory Postgres with the real migrations (minus the Supabase-only
 * Vault/pg_cron file), an issuer, and settings suitable for tests.
 */
export async function freshDb(settings = {}) {
  const pg = new PGlite();
  for (const file of fs.readdirSync(migrations).sort()) {
    if (file.includes('supabase_platform')) continue;
    await pg.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  }

  await pg.query(
    `insert into einvoice.issuer (registered_name, afm, tax_office, street, street_number, city, postal_code)
     values ('Storage Co ΙΚΕ', $1, 'ΔΟΥ Αθηνών', 'Λεωφόρος Κηφισίας', '10', 'Αθήνα', '11526')`,
    [ISSUER_AFM],
  );

  const all = { sg_api_url: 'https://acme.storeganise.com/api', sg_business_code: 'acme', ...settings };
  for (const [key, value] of Object.entries(all)) {
    await pg.query(
      `insert into einvoice.settings (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value`,
      [key, JSON.stringify(value)],
    );
  }

  setDb({ query: (text, params) => pg.query(text, params) });
  clearConfigCache();
  return pg;
}

export async function setSetting(pg, key, value) {
  await pg.query(`update einvoice.settings set value = $2 where key = $1`, [key, JSON.stringify(value)]);
  clearConfigCache();
}

export async function testConfig(overrides = {}) {
  const cfg = await loadConfig({ fresh: true });
  return { ...cfg, settings: { ...cfg.settings, ...overrides } };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export function businessCustomer(overrides = {}) {
  return {
    id: 'user-b2b',
    firstName: 'Νίκος',
    lastName: 'Παππάς',
    email: 'accounts@example.gr',
    address: { line1: 'Ερμού 5', city: 'Αθήνα', postcode: '10563', country: 'GR' },
    customFields: {
      ei_is_business: true,
      ei_afm: CUSTOMER_AFM,
      ei_doy: 'ΔΟΥ Α Αθηνών',
      ei_company_name: 'Example Trading ΑΕ',
      ...overrides,
    },
  };
}

export function privateCustomer() {
  return {
    id: 'user-b2c',
    firstName: 'Maria',
    lastName: 'K.',
    email: 'maria@example.com',
    customFields: {},
  };
}

/**
 * One Storeganise invoice entry (line), shaped like the real API response in
 * test/fixtures/sg-invoice.json: Storeganise supplies net, VAT and total per line.
 */
export function entry(code, desc, amount, { qty = 1, taxPct = 24, type = 'revenue' } = {}) {
  const r = n => Math.round(n * 100) / 100;
  const subtotal = r(amount * qty);
  const tax = r((subtotal * taxPct) / 100);
  return { id: `e-${code}-${amount}`, desc, code, type, tags: [code], amount, qty, subtotal, taxPct, tax, total: r(subtotal + tax) };
}

/**
 * A fully paid Storeganise invoice (bank transfer) in the shape its API returns
 * (see normalize.js). Only paid invoices are sent (FRD v1.3); see unpaidInvoice().
 */
export function sgInvoice(overrides = {}) {
  return {
    id: 'inv-1',
    sid: 'INV-1001',
    state: 'paid',
    siteId: 'site-1',
    startDate: '2026-10-01',
    endDate: '2026-10-31',
    sent: '2026-10-01T02:00:00.000Z',
    paid: '2026-10-03T09:00:00.000Z',
    subtotal: 100,
    tax: 24,
    taxPercent: null,
    total: 124,
    balance: 0,
    items: [],
    entries: [entry('rent', 'Unit A12 — October', 100)],
    owner: businessCustomer(),
    payments: [{ id: 'pay-1', type: 'payment', method: 'bank', amount: 124 }],
    customFields: {},
    ...overrides,
  };
}

/** The same invoice issued but not paid yet: a pro forma (payment request). */
export function unpaidInvoice(overrides = {}) {
  return sgInvoice({ state: 'sent', paid: null, balance: 124, payments: [], ...overrides });
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

export function fakeStoreganise(invoices = {}) {
  const store = new Map(Object.entries(invoices));
  const writes = [];
  return {
    store,
    writes,
    reads: 0,
    async getInvoice(id) {
      this.reads++;
      const invoice = store.get(id);
      return invoice ? structuredClone(invoice) : null;
    },
    async getUser(id) {
      return { id, customFields: {} };
    },
    async listInvoices({ offset = 0, limit = 100 }) {
      return [...store.values()].slice(offset, offset + limit);
    },
    async updateInvoiceCustomFields(id, fields) {
      if (!store.has(id)) return { skipped: 'invoice deleted' };
      writes.push({ id, fields });
      const invoice = store.get(id);
      invoice.customFields = { ...invoice.customFields, ...fields };
      return invoice;
    },
  };
}

/**
 * Impact stand-in. `responses` is a queue of { status, body } used in order;
 * 'accept' (or an empty queue) accepts the document like Impact does: 201 with a
 * SignatureResponse carrying a numeric MARK. { acceptAnd } stores the document but
 * answers with another response (e.g. a lost 201 seen as a timeout).
 */
export function fakeImpact({ responses = [], documents = [] } = {}) {
  let seq = 400000000000000;
  const sent = [];
  const docs = [...documents];

  const store = (payload, extra = {}) => {
    seq++;
    const doc = {
      mark: seq,
      uid: `UID${seq}`,
      authenticationCode: `AUTH${seq}`,
      url: `https://einvoiceportaluat.impact.gr/v/${seq}`,
      status: 'SUBMITTED',
      series: payload.Series,
      number: payload.Number,
      dateIssued: payload.DateIssued,
      totalAmount: payload.Summaries?.TotalGrossValue,
      success: true,
      ...extra,
    };
    docs.push(doc);
    return doc;
  };

  const respond = result => ({ ...result, outcome: classify(result.status) });

  return {
    sent,
    docs,
    responses,
    async sendDocument(payload) {
      sent.push(structuredClone(payload));
      const next = responses.shift();
      if (next === 'accept' || !next) return respond({ status: 201, body: store(payload) });
      if (next.acceptAnd) {
        store(payload);
        return respond(next.acceptAnd);
      }
      if (next.pending) {
        // Sign policy DEFAULT: stored, AADE not reached yet, MARK comes later
        const doc = store(payload, { status: 'PENDING' });
        const body = { ...doc, mark: null, uid: null, authenticationCode: null };
        doc.mark = null;
        doc.pendingMark = ++seq;
        return respond({ status: 201, body });
      }
      if (next.duplicateOf !== undefined) {
        // 409 carries the stored document's SignatureResponse
        return respond({ status: 409, body: docs[next.duplicateOf] });
      }
      return respond(next);
    },
    /** Simulates AADE assigning the MARK to a PENDING document. */
    releasePending() {
      for (const d of docs) if (d.pendingMark) Object.assign(d, { mark: d.pendingMark, status: 'SUBMITTED', pendingMark: null });
    },
    async findDocument({ series, number }) {
      const d = docs.find(x => x.series === series && Number(x.number) === Number(number));
      return {
        ok: true,
        document: d && { mark: d.mark ? String(d.mark) : null, uid: d.uid, authCode: d.authenticationCode, url: d.url },
      };
    },
    async getAllDocuments() {
      return {
        ok: true,
        documents: docs.map(d => ({
          ...d, mark: d.mark ? String(d.mark) : null, authCode: d.authenticationCode, totalAmount: Number(d.totalAmount),
        })),
      };
    },
    async apiKey() {
      return 'c0e4a18d-d3b4-40e6-92d0-ac96becb01c8';
    },
    async portalUrl() {
      return 'https://einvoiceportaluat.impact.gr';
    },
  };
}
