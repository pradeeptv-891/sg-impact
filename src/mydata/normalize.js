import crypto from 'crypto';

import { COUNTRY_ALIASES } from './constants.js';
import { cleanAfm } from './afm.js';
import { roundCents, toCents } from './money.js';

/**
 * The one place that knows Storeganise's field names. Everything downstream works
 * on the normalised shape, so if a field turns out to be named differently for this
 * operator, only this file changes.
 *
 * Confirmed against a real Storeganise invoice (test/fixtures/sg-invoice.json):
 *   invoice  id, sid, state, type, siteId, unitRentalId, sent, paid, failed,
 *            startDate, endDate, subtotal, tax, taxPercent (may be null), total,
 *            amountPaid, balance, creditApplied, meta, owner, payments, entries
 *   entries  the invoice lines: { id, desc, code, type, date, endDate, tags,
 *            amount (unit price), qty, subtotal (net), taxPct, tax (VAT), total }
 *   payments { id, created, type, amount, date, method }
 * `items` on an invoice is NOT the invoice lines (it is valet storage items) and
 * is only used when `entries` is absent.
 */
export function normalizeInvoice(raw, settings = {}) {
  const discountTypes = new Set((settings.sg_discount_line_types || []).map(lower));
  const refundTypes = new Set((settings.sg_refund_payment_types || ['refund']).map(lower));
  const pricesIncludeTax = settings.prices_include_tax === true;
  const invoiceRate = percent(raw.taxPercent ?? raw.taxRate);

  const source = Array.isArray(raw.entries) ? raw.entries : raw.lines || raw.items || [];

  const lines = source.map((entry, index) => {
    const quantity = Number(entry.qty ?? entry.quantity ?? 1) || 0;
    const unitPrice = Number(entry.amount ?? entry.price ?? entry.unitPrice ?? 0);
    const rate = percent(entry.taxPct ?? entry.taxPercent ?? entry.taxRate) ?? invoiceRate ?? 0;
    const type = lower(entry.type ?? entry.lineType) || null;
    const code = entry.code ?? entry.accountCode ?? entry.accountingCode ?? null;

    let netCents;
    let vatCents;
    if (entry.subtotal !== undefined && entry.subtotal !== null && entry.tax !== undefined && entry.tax !== null) {
      // Storeganise's own per-line figures: use them as-is so totals match exactly
      netCents = toCents(entry.subtotal);
      vatCents = toCents(entry.tax);
    } else {
      const amountCents = toCents(unitPrice * quantity);
      if (pricesIncludeTax) {
        netCents = roundCents(amountCents / (1 + rate / 100));
        vatCents = amountCents - netCents;
      } else {
        netCents = amountCents;
        vatCents = roundCents((netCents * rate) / 100);
      }
    }

    return {
      index,
      id: entry.id ?? null,
      type,
      accountingCode: code === null ? null : String(code),
      tags: Array.isArray(entry.tags) ? entry.tags.map(lower) : [],
      description: String(entry.desc ?? entry.description ?? entry.title ?? code ?? 'Item').trim(),
      quantity,
      vatRate: rate,
      netCents,
      vatCents,
      grossCents: netCents + vatCents,
      isDiscount: discountTypes.has(type) || discountTypes.has(lower(code)) || netCents < 0,
      startDate: entry.date ?? entry.startDate ?? null,
      endDate: entry.endDate ?? null,
    };
  });

  const payments = (raw.payments || []).map(payment => {
    const amountCents = toCents(payment.amount);
    return {
      id: String(payment.id ?? ''),
      type: lower(payment.type),
      method: lower(payment.method ?? payment.type) || '*',
      amountCents,
      date: payment.date ?? payment.created ?? null,
      isRefund: refundTypes.has(lower(payment.type)) || amountCents < 0,
    };
  });

  return {
    id: String(raw.id),
    sid: raw.sid ?? null,
    state: raw.state ?? null,
    siteId: raw.siteId ?? raw.site?.id ?? null,
    ownerId: raw.ownerId ?? raw.owner?.id ?? null,
    owner: typeof raw.owner === 'object' ? raw.owner : null,
    invoiceType: raw.type ?? null,
    creditNoteId: raw.meta?.creditNote ?? null,
    created: raw.created ?? null,
    updated: raw.updated ?? raw.updatedAt ?? null,
    sentAt: raw.sent ?? null,
    paidAt: raw.paid ?? null,
    startDate: raw.startDate ?? null,
    endDate: raw.endDate ?? null,
    subtotalCents: raw.subtotal === undefined ? null : toCents(raw.subtotal),
    taxCents: raw.tax === undefined || raw.tax === null ? null : toCents(raw.tax),
    totalCents: toCents(raw.total),
    balanceCents: raw.balance === undefined || raw.balance === null ? null : toCents(raw.balance),
    creditAppliedCents: toCents(raw.creditApplied || 0),
    lines,
    payments,
    customFields: raw.customFields || {},
  };
}

export function normalizeCustomer(owner) {
  if (!owner) return null;
  const cf = owner.customFields || {};
  // Storeganise keeps the user address as free text (e.g. "Ερμού 5, Αθήνα 10563");
  // structured values for B2B come from the ei_* custom fields.
  const address = typeof owner.address === 'object' && owner.address ? owner.address : {};

  const name = owner.name || [owner.firstName, owner.lastName].filter(Boolean).join(' ').trim() || null;

  return {
    id: owner.id ?? null,
    email: owner.email ?? null,
    name,
    isBusiness: truthy(cf.ei_is_business),
    companyName: clean(cf.ei_company_name) || clean(owner.companyName) || clean(owner.company) || null,
    afm: cleanAfm(cf.ei_afm) || null,
    doy: clean(cf.ei_doy) || null,
    address: {
      street: clean(cf.ei_address) || clean(address.line1) || clean(address.street) || clean(address.address1)
        || (typeof owner.address === 'string' ? clean(owner.address) : null),
      city: clean(cf.ei_city) || clean(address.city) || clean(address.town) || null,
      postcode: clean(cf.ei_postcode) || clean(address.postcode) || clean(address.postalCode) || clean(address.zip) || null,
      country: countryCode(cf.ei_country || address.country || address.countryCode) || 'GR',
    },
  };
}

/**
 * Amounts-and-lines fingerprint of an invoice. A different fingerprint after the
 * document was sent means the invoice was edited after issue (FR-COR-03).
 */
export function fingerprint(invoice) {
  const material = JSON.stringify({
    total: invoice.totalCents,
    lines: invoice.lines.map(l => [l.type, l.accountingCode, l.description, l.quantity, l.netCents, l.vatRate]),
  });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
}

export function countryCode(value) {
  const v = clean(value)?.toUpperCase();
  if (!v) return null;
  if (/^[A-Z]{2}$/.test(v)) return v === 'EL' ? 'GR' : v;
  return COUNTRY_ALIASES[v] || null;
}

function percent(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Accept 0.24 as well as 24
  return n > 0 && n < 1 ? Math.round(n * 10000) / 100 : n;
}

function lower(value) {
  return value === undefined || value === null ? '' : String(value).trim().toLowerCase();
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s || null;
}

export function truthy(value) {
  return value === true || value === 1 || ['true', 'yes', '1', 'on', 'y', 'ναι'].includes(lower(value));
}
