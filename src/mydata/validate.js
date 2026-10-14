import { isValidAfm } from './afm.js';

/**
 * FR-MAP-07: pre-transmission validation against Impact's minimum and mandatory
 * fields for documents sent to AADE (developers.s1ecos.com → Minimum & Conditional
 * Fields, Mandatory Fields B2B/B2C), plus internal consistency of the totals.
 * Anything that fails here is marked failed_data and never sent.
 */
export function validateDocument(payload, { customerKind, isCredit = false } = {}) {
  const errors = [];
  const need = (value, message) => {
    if (value === undefined || value === null || value === '') errors.push(message);
  };

  need(payload.CurrencyCode, 'Currency missing');
  need(payload.InvoiceType, 'Document type name missing');
  need(payload.InvoiceTypeCode, 'Document type code missing');
  need(payload.DocumentTypeCode, 'Document type category missing');
  need(payload.Series, 'Series missing');
  need(payload.Number, 'Number missing');
  need(payload.DateIssued, 'Issue date missing');

  const issuer = payload.Issuer || {};
  need(issuer.RegisteredName, 'Issuer registered name missing');
  if (!isValidAfm(issuer.Vat)) errors.push('Issuer ΑΦΜ missing or invalid');
  need(issuer.Address?.CountryCode, 'Issuer country missing');

  need(payload.DistributionDetails?.InternalDocumentId, 'Storeganise invoice id missing');

  if (customerKind === 'b2b') {
    const cp = payload.CounterParty || {};
    need(cp.RegisteredName, 'Customer registered company name missing');
    if (!cp.Vat) errors.push('Customer ΑΦΜ missing');
    else if (cp.Address?.CountryCode === 'GR' && !isValidAfm(cp.Vat)) errors.push('Customer ΑΦΜ invalid');
    need(cp.Address?.CountryCode, 'Customer country missing');
    need(cp.Address?.City, 'Customer city missing');
    need(cp.Address?.Postal, 'Customer postal code missing');
  }

  if (isCredit && payload.InvoiceTypeCode === '5.1' && !(payload.CorrelatedInvoices || []).length) {
    errors.push('Credit note has no original MARK to correlate to');
  }

  const details = payload.Details || [];
  if (!details.length) errors.push('Document has no lines');

  let net = 0;
  let vat = 0;
  details.forEach(d => {
    const where = `line ${d.LineNo}`;
    if (!(d.Quantity > 0)) errors.push(`Quantity must be positive on ${where}`);
    if (d.NetTotal < 0 || d.VATTotal < 0) errors.push(`Negative amount on ${where}`);
    need(d.Code, `Item code missing on ${where}`);
    need(d.Descriptions?.[0], `Description missing on ${where}`);
    need(d.VatCategoryCode, `VAT category missing on ${where}`);
    if (d.VatCategoryCode === 7) need(d.VatExemptionCategoryCode, `VAT exemption reason missing on ${where}`);
    need(d.IncomeClassification?.ClassificationTypeCode, `Income classification type missing on ${where}`);
    need(d.IncomeClassification?.ClassificationCategoryCode, `Income classification category missing on ${where}`);
    if (cents(d.IncomeClassification?.Amount) !== cents(d.NetTotal)) errors.push(`Classification amount ≠ net on ${where}`);
    if (cents(d.NetTotal) + cents(d.VATTotal) !== cents(d.Total)) errors.push(`Net + VAT ≠ total on ${where}`);
    net += cents(d.NetTotal);
    vat += cents(d.VATTotal);
  });

  const s = payload.Summaries || {};
  if (cents(s.TotalNetAmount) !== net) errors.push('Total net does not equal the sum of the lines');
  if (cents(s.TotalVATAmount) !== vat) errors.push('Total VAT does not equal the sum of the lines');
  if (cents(s.TotalGrossValue) !== net + vat) errors.push('Total gross does not equal net + VAT');

  const analysis = payload.VatAnalysis || [];
  if (!analysis.length) errors.push('VAT analysis missing');
  const analysisVat = analysis.reduce((a, v) => a + cents(v.VatAmount), 0);
  const analysisNet = analysis.reduce((a, v) => a + cents(v.UnderlyingValue), 0);
  if (analysisVat !== vat || analysisNet !== net) errors.push('VAT analysis does not match the lines');

  const methods = payload.PaymentDetails?.PaymentMethods || [];
  if (!methods.length) errors.push('Payment method missing');
  methods.forEach(m => {
    need(m.PaymentMethodTypeCode, 'Payment method code missing');
  });
  const paid = methods.reduce((a, m) => a + cents(m.Amount), 0);
  if (methods.length && paid !== net + vat) errors.push('Payment amounts do not add up to the document total');

  const additional = payload.AdditionalDetails || {};
  need(additional.TransmissionMethod, 'Transmission method missing');
  if (additional.TransmissionMethod === 'E' && !(additional.AccountingDepartmentEmails || []).some(Boolean)) {
    errors.push('Email delivery requested but the customer has no email');
  }
  if (['M', 'C'].includes(additional.TransmissionMethod) && !(additional.CustomerCellNumbers || []).some(Boolean)) {
    errors.push('SMS / Viber delivery requested but the customer has no Greek mobile number');
  }

  return [...new Set(errors)];
}

function cents(value) {
  return Math.round(Number(value || 0) * 100);
}
