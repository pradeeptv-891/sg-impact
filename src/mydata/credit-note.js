import { RATE_BY_VAT_CATEGORY, VAT_EXEMPT_CATEGORY, NO_VAT_CATEGORY } from './constants.js';
import { allocate, roundCents, toCents, toEuros } from './money.js';
import { formatDate, summaries, vatAnalysis } from './mapper.js';

/**
 * Credit note built from the original document as it was sent (FRD Module 6), so
 * it credits exactly what was issued even if Storeganise has changed since.
 *
 *   amountCents = null  → full credit: every original line
 *   amountCents = n     → partial credit: n (gross) spread across the original VAT
 *                         rates in proportion, one line per rate
 *
 * 5.1 must carry CorrelatedInvoices (the original MARK, int64). 11.4 accepts it too.
 * DocumentTypeCode stays "INVOICE": that is Impact's code for any fiscal document
 * sent to AADE, credits included.
 */
export function buildCreditNote({ original, originalJob, amountCents = null, rule, numbering, correctionKey, reason }) {
  const errors = [];
  if (!originalJob.mark) errors.push('Original document has no MARK');
  if (!rule) errors.push(`No credit-note rule for ${originalJob.customer_kind?.toUpperCase() || 'this'} customer`);

  const originalGross = toCents(original.Summaries.TotalGrossValue);
  if (amountCents !== null && (amountCents <= 0 || amountCents > originalGross)) {
    errors.push(`Credit amount ${toEuros(amountCents)} is outside 0 – ${toEuros(originalGross)}`);
  }
  if (errors.length) return { ok: false, errors };

  const details = amountCents === null || amountCents === originalGross
    ? original.Details.map(d => ({ ...d }))
    : partialLines(original, amountCents, reason);

  const net = details.reduce((a, d) => a + toCents(d.NetTotal), 0);
  const vat = details.reduce((a, d) => a + toCents(d.VATTotal), 0);

  const originalMethod = original.PaymentDetails?.PaymentMethods?.[0];

  const payload = {
    IAPRSignPolicy: original.IAPRSignPolicy,
    CurrencyCode: 'EUR',
    InvoiceType: rule.invoice_type_name,
    InvoiceTypeCode: rule.invoice_type_code,
    DocumentType: rule.invoice_type_name,
    DocumentTypeCode: rule.document_type_code,
    Series: numbering?.series || rule.series_code,
    Number: numbering ? String(numbering.number) : '0',
    DateIssued: formatDate(numbering?.dateIssued || new Date()),
    CorrelatedInvoices: [Number(originalJob.mark)],
    Issuer: original.Issuer,
    ...(original.CounterParty && { CounterParty: original.CounterParty }),
    DistributionDetails: {
      InternalDocumentId: `${originalJob.sg_invoice_id}:credit:${correctionKey}`,
    },
    PaymentDetails: {
      PaymentMethods: [{
        PaymentMethodType: originalMethod?.PaymentMethodType || 'Επί Πιστώσει',
        PaymentMethodTypeCode: originalMethod?.PaymentMethodTypeCode ?? 5,
        Amount: toEuros(net + vat),
      }],
    },
    AdditionalDetails: original.AdditionalDetails,
    Details: details,
    Summaries: summaries(net, vat),
    VatAnalysis: vatAnalysis(details),
    IsDelayedCode: 0,
  };

  return { ok: true, errors: [], payload, totals: { netCents: net, vatCents: vat, grossCents: net + vat } };
}

function partialLines(original, amountCents, reason) {
  // Group original lines by VAT category, keeping the first line's classification
  const groups = new Map();
  for (const d of original.Details) {
    const g = groups.get(d.VatCategoryCode) || { template: d, grossCents: 0 };
    g.grossCents += toCents(d.Total);
    groups.set(d.VatCategoryCode, g);
  }

  const list = [...groups.values()];
  const parts = allocate(amountCents, list.map(g => g.grossCents));
  const label = `Credit${reason ? `: ${reason}` : ''} — ${original.Series}-${original.Number}`;

  return list.map((g, i) => {
    const gross = parts[i];
    const category = g.template.VatCategoryCode;
    const rate = category === VAT_EXEMPT_CATEGORY || category === NO_VAT_CATEGORY ? 0 : RATE_BY_VAT_CATEGORY[category] || 0;
    const net = roundCents(gross / (1 + rate / 100));
    return {
      LineNo: i + 1,
      Code: g.template.Code,
      Descriptions: [label],
      MeasurementUnitCode: 1,
      Quantity: 1,
      UnitPrice: toEuros(net),
      NetTotal: toEuros(net),
      VATTotal: toEuros(gross - net),
      Total: toEuros(gross),
      VatCategory: g.template.VatCategory,
      VatCategoryCode: category,
      ...(g.template.VatExemptionCategoryCode && { VatExemptionCategoryCode: g.template.VatExemptionCategoryCode }),
      IsInformative: false,
      IsHidden: false,
      RecordTypeCode: 0,
      IncomeClassification: { ...g.template.IncomeClassification, Amount: toEuros(net) },
    };
  }).filter(line => toCents(line.Total) > 0);
}
