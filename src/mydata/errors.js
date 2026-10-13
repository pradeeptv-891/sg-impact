/**
 * FR-ERR-03: Impact / myDATA error bodies → one short, actionable line for the
 * invoice's ei_error field. The full body is always kept in the audit log and on
 * the job, so nothing is lost by shortening it here.
 *
 * Impact's 400 body (BadRequestResponse):
 *   { success, message, statusCode, errorMessage, errors: [string],
 *     myDataErrors: [{ key, value }], myDataResponse, myDataRequest }
 */
const PATTERNS = [
  // Most specific first: a counterparty postal/city/name error mentions the counterparty too
  [/counter\s*party.*(postal|zip)/i, 'Customer postal code invalid or missing'],
  [/counter\s*party.*city/i, 'Customer city missing'],
  [/counter\s*party.*name/i, 'Customer registered name missing'],
  [/counter\s*party.*(vat|afm|tin)|(vat|afm|tin).*counter\s*party|receiver.*vat|(vat|afm) number|does not belong to (an )?active/i, 'Customer ΑΦΜ invalid or missing'],
  [/issuer.*(vat|afm|tin)|api\s*key|authenticat/i, 'Issuer ΑΦΜ / API key rejected (check issuer settings and Impact onboarding)'],
  [/classification/i, 'Income classification rejected (check line mapping)'],
  [/vat\s*exemption|exemption/i, 'VAT exemption reason missing or invalid (check line mapping)'],
  [/vat\s*category|vatcategory/i, 'VAT category rejected (check line mapping)'],
  [/payment/i, 'Payment method rejected (check payment method mapping)'],
  [/series|aa\b|number.*(exist|duplicate)/i, 'Series / number rejected'],
  [/correlat|mark/i, 'Original MARK rejected on credit note'],
  [/total|amount|sum/i, 'Amounts rejected: totals do not add up'],
];

export function impactErrorMessages(body) {
  if (!body) return [];
  if (typeof body === 'string') return [body];

  const out = [];
  const push = v => {
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach(push);
    else if (typeof v === 'object') push(v.value ?? v.message ?? v.Message ?? v.errorMessage ?? v.description ?? v.error ?? JSON.stringify(v));
    else out.push(String(v));
  };

  // AADE's own validation messages first: they are the most specific
  push(body.myDataErrors);

  // ASP.NET ProblemDetails: { title, errors: { field: [messages] } }
  if (body.errors && !Array.isArray(body.errors) && typeof body.errors === 'object') {
    for (const [field, messages] of Object.entries(body.errors)) {
      [].concat(messages).forEach(m => out.push(field ? `${field}: ${m}` : String(m)));
    }
  } else {
    push(body.errors || body.Errors);
  }

  if (!out.length) push(body.errorMessage || body.message || body.Message || body.title || body.error || body.raw);

  return out;
}

export function readableImpactError(body, status) {
  const messages = impactErrorMessages(body);
  const first = messages[0] || `Impact rejected the document (HTTP ${status})`;

  for (const [pattern, readable] of PATTERNS) {
    if (messages.some(m => pattern.test(m))) {
      return truncate(`${readable} — ${first}`);
    }
  }
  return truncate(first);
}

function truncate(s, max = 250) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
