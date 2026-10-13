import { query } from './db.js';

/**
 * FR-ERR-01: one row per inbound webhook, Impact request/response and Storeganise
 * write-back. Headers are never passed in, so credentials cannot end up here.
 *
 * Every row carries the company (scope §10.3): passed in, or taken from the job.
 *
 * Audit failures are reported but never break the caller: losing a log line is
 * better than losing a transmission result.
 */
export async function audit({
  kind,
  companyId = null,
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
         (kind, job_id, sg_invoice_id, method, url, status_code, duration_ms, request, response, error, company_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               coalesce($11::uuid, (select company_id from einvoice.jobs where id = $2::uuid)))`,
      [kind, jobId, sgInvoiceId, method, url, statusCode, durationMs, toJson(request), toJson(response), error, companyId],
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
