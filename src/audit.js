import { query } from './db.js';

/**
 * FR-ERR-01: one row per inbound webhook, Impact request/response and Storeganise
 * write-back. Headers are never passed in, so credentials cannot end up here.
 *
 * Audit failures are reported but never break the caller: losing a log line is
 * better than losing a transmission result.
 */
export async function audit({
  kind,
  jobId = null,
  sgInvoiceId = null,
  method = null,
  url = null,
  statusCode = null,
  durationMs = null,
  request = null,
  response = null,
  error = null,
}) {
  try {
    await query(
      `insert into einvoice.audit_log
         (kind, job_id, sg_invoice_id, method, url, status_code, duration_ms, request, response, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [kind, jobId, sgInvoiceId, method, url, statusCode, durationMs, toJson(request), toJson(response), error],
    );
  } catch (err) {
    console.error('Audit log write failed', { kind, sgInvoiceId, message: err.message });
  }
}

function toJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return JSON.stringify({ text: value.slice(0, 10000) });
  return JSON.stringify(value);
}
