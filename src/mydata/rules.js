import { EU_COUNTRIES } from './constants.js';
import { isValidAfm } from './afm.js';

/**
 * Rule lookups against the accountant-approved configuration tables. A `null`
 * column on a rule means "any"; the most specific matching rule wins, then the
 * lowest priority number.
 */

export function customerKind(customer) {
  return customer?.isBusiness ? 'b2b' : 'b2c';
}

export function region(customer) {
  const country = customer?.address?.country || 'GR';
  if (country === 'GR') return 'GR';
  return EU_COUNTRIES.has(country) ? 'EU' : 'NON_EU';
}

function bestMatch(rows, criteria, weights) {
  let best = null;
  let bestScore = -1;

  for (const row of rows) {
    let score = 0;
    let matches = true;
    for (const [column, value] of Object.entries(criteria)) {
      const expected = row[column];
      if (expected === null || expected === undefined) continue;
      if (String(expected).toLowerCase() !== String(value ?? '').toLowerCase()) {
        matches = false;
        break;
      }
      score += weights[column] || 1;
    }
    // rows arrive sorted by priority, so the first at a given score wins
    if (matches && score > bestScore) {
      best = row;
      bestScore = score;
    }
  }

  return best;
}

export function resolveLineMapping(line, kind, lineMappings) {
  return bestMatch(
    lineMappings,
    { accounting_code: line.accountingCode, line_type: line.type, customer_kind: kind },
    { accounting_code: 4, line_type: 2, customer_kind: 1 },
  );
}

export function resolveDocTypeRule({ kind, customerKind: ck, region: rg, nature }, docTypeRules) {
  const rows = docTypeRules.filter(rule => rule.kind === kind);
  return bestMatch(rows, { customer_kind: ck, region: rg, nature }, { customer_kind: 4, region: 2, nature: 1 });
}

/** The rule for a document type already locked on a job (number reserved). */
export function ruleForTypeCode(kind, invoiceTypeCode, docTypeRules) {
  return docTypeRules.find(rule => rule.kind === kind && rule.invoice_type_code === invoiceTypeCode) || null;
}

/**
 * FRD v1.3: an invoice is a pro forma until it is fully paid, and nothing reaches
 * Impact (or even gets a job) before then (FR-CAP-03 / FR-CAP-05). This is the one
 * definition of "fully paid", used by the webhook, the poll, the reconciliation and
 * the worker. Partly paid invoices are not paid.
 */
export function isFullyPaid(invoice, settings = {}) {
  if ((settings.sg_void_states || []).includes(invoice.state)) return false;
  if ((settings.sg_paid_states || ['paid']).includes(invoice.state)) return true;
  return invoice.balanceCents !== null && invoice.balanceCents <= 0 && invoice.totalCents > 0;
}

export function paymentMethodFor(sgMethod, paymentMethods) {
  return paymentMethods[String(sgMethod || '*').toLowerCase()] || paymentMethods['*'] || null;
}

/**
 * FR-CUS-01 / FR-CUS-02: tax data a business customer must have before a B2B
 * invoice can be issued. Returns readable messages for ei_error.
 */
export function businessCustomerProblems(customer) {
  const problems = [];
  const country = customer.address.country;

  if (!customer.afm) problems.push('Customer ΑΦΜ missing');
  else if (country === 'GR' && !isValidAfm(customer.afm)) problems.push(`Customer ΑΦΜ ${customer.afm} is invalid (checksum)`);

  if (!customer.companyName) problems.push('Customer registered company name missing');
  if (!customer.address.city) problems.push('Customer city missing');
  if (!customer.address.postcode) problems.push('Customer postal code missing');
  else if (country === 'GR' && !/^\d{5}$/.test(customer.address.postcode.replace(/\s/g, ''))) {
    problems.push(`Customer postal code "${customer.address.postcode}" is not a 5-digit Greek code`);
  }

  return problems;
}
