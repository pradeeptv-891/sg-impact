import crypto from 'crypto';

/**
 * Impact offline QR code (developers.s1ecos.com → Offline QR Code Instructions).
 *
 * When a document cannot reach Impact (issuer ↔ provider, IsDelayedCode 1) or
 * Impact cannot reach AADE (provider ↔ AADE, IsDelayedCode 2), the provider-issued
 * document can still be legally handed over with an offline QR. It must later be
 * transmitted unchanged with the same IsDelayedCode.
 *
 * signature = sha1_hex(utf8(
 *   {issuerTin}-{customerTin}-{series}-{number}-{dateIssued}-{totalAmount}-{internalId}{APIKey}
 * ))   ← no hyphen before the API key
 */
export function offlineQrSignature({ issuerTin, customerTin = '', series, number, dateIssued, totalAmount, internalId }, apiKey) {
  const material = `${issuerTin}-${customerTin}-${series}-${number}-${dateIssued}-${totalAmount}-${internalId}${apiKey}`;
  return crypto.createHash('sha1').update(Buffer.from(material, 'utf8')).digest('hex');
}

/** Builds the offline QR URL from the exact payload that will later be sent. */
export function buildOfflineQr(payload, { apiKey, portalUrl }) {
  const fields = {
    issuerTin: payload.Issuer.Vat,
    customerTin: payload.CounterParty?.Vat || '',
    customerName: payload.CounterParty?.RegisteredName || '',
    invoiceType: payload.InvoiceTypeCode,
    series: payload.Series,
    number: payload.Number,
    dateIssued: compactDate(payload.DateIssued),
    totalAmount: amount(payload.Summaries.TotalGrossValue),
    totalNetAmount: amount(payload.Summaries.TotalNetAmount),
    totalVatAmount: amount(payload.Summaries.TotalVATAmount),
    internalId: payload.DistributionDetails.InternalDocumentId,
  };
  const signature = offlineQrSignature(fields, apiKey);

  // Parameter names as in Impact's worked example
  const params = new URLSearchParams({
    IssuerTin: fields.issuerTin,
    CustomerTin: fields.customerTin,
    CustomerName: fields.customerName,
    InvoiceType: fields.invoiceType,
    Series: fields.series,
    Number: fields.number,
    DateIssued: fields.dateIssued,
    TotalAmount: fields.totalAmount,
    TotalNetAmount: fields.totalNetAmount,
    TotalVatAmount: fields.totalVatAmount,
    InternalId: fields.internalId,
    Signature: signature,
  });

  return { url: `${portalUrl.replace(/\/$/, '')}/TransmissionFailure?${params}`, signature };
}

/** 2025-06-21T10:13:02 → 20250621101302 (yyyyMMddHHmmss, not ISO) */
export function compactDate(value) {
  return String(value).replace(/[^0-9]/g, '').slice(0, 14).padEnd(14, '0');
}

/** 124 → "124", 12.4 → "12.4": the JSON number as sent. Confirm decimals in UAT. */
function amount(value) {
  return String(Number(value));
}

/** Text Impact requires on the printout of an offline-issued document. */
export const OFFLINE_NOTICE = {
  1: 'Απώλεια Διασύνδεσης Επιχείρησης - Παρόχου - Transmission Failure_1',
  2: 'Απώλεια Διασύνδεσης Παρόχου - ΑΑΔΕ - Transmission Failure_2',
};
