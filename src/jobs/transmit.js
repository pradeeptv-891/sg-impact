import { extractIdentifiers } from '../impact-api.js';
import { readableImpactError } from '../mydata/errors.js';
import { buildOfflineQr } from '../mydata/offline-qr.js';
import * as repo from './repo.js';

/**
 * FR-TX-03 / FRD 5.3: turns an Impact call's outcome into the job's next state.
 *
 *   201 SUBMITTED  → sent, identifiers stored
 *   201 PENDING    → sent; Impact holds it and forwards to AADE later (sign policy
 *                    0/1). The MARK is looked up until it appears.
 *   201 INVALID    → failed_data (sign policy 1 stores invalid documents)
 *   409            → already at AADE: Impact returns the same identifiers
 *   400            → failed_data, no automatic retry (re-queued by an operator)
 *   408 / 5xx / network → retry with backoff on the same number, failed after the limit.
 *                    408 means AADE is unreachable, or the same UID is still being
 *                    processed by an earlier request.
 */
export async function applyResult(job, result, ctx) {
  const { impact, cfg } = ctx;
  const settings = cfg.settings;

  if (result.outcome === 'success' || result.outcome === 'duplicate') {
    let ids = extractIdentifiers(result.body);

    if (result.outcome === 'success' && ids.status === 'INVALID') {
      return repo.updateJob(job.id, {
        status: 'failed_data',
        status_reason: 'Stored by Impact as INVALID (rejected by AADE)',
        impact_status: 'INVALID',
        last_error: readableImpactError(result.body, result.status),
        last_error_detail: { status: result.status, body: result.body },
        response: result.body,
        writeback_pending: true,
      });
    }

    // The MARK normally comes back in the response (201 and 409 alike). If not,
    // look the document up by series/number.
    if (!ids.mark && job.series_code && job.number && ids.status !== 'PENDING') {
      const found = await impact.findDocument({ series: job.series_code, number: job.number, dateIssued: job.date_issued });
      if (found.ok && found.document) ids = { ...found.document, ...pickDefined(ids) };
    }

    if (result.outcome === 'duplicate' && !ids.mark) {
      return retryOrFail(job, 'Impact reports the document already exists but its MARK could not be retrieved yet', result, settings);
    }

    let reason = null;
    if (result.outcome === 'duplicate') reason = 'Already at AADE (409); identifiers recovered';
    else if (!ids.mark) reason = `Accepted by Impact (${ids.status || 'no MARK yet'}); MARK will be looked up`;

    const followupMinutes = Number(settings.mark_followup_minutes) || 15;

    return repo.updateJob(job.id, {
      status: 'sent',
      status_reason: reason,
      impact_status: ids.status || null,
      mark: ids.mark || null,
      uid: ids.uid || null,
      auth_code: ids.authCode || null,
      qr_url: ids.url || null,
      sent_at: new Date(),
      response: result.body,
      last_error: null,
      last_error_detail: null,
      writeback_pending: true,
      ...(!ids.mark && { next_attempt_at: new Date(Date.now() + followupMinutes * 60000) }),
    });
  }

  if (result.outcome === 'invalid') {
    return repo.updateJob(job.id, {
      status: 'failed_data',
      status_reason: `Rejected by Impact (HTTP ${result.status})`,
      last_error: readableImpactError(result.body, result.status),
      last_error_detail: { status: result.status, body: result.body },
      response: result.body,
      writeback_pending: true,
    });
  }

  let what;
  if (result.status === 408) what = 'AADE unreachable or document still processing (HTTP 408)';
  else if (result.status) what = `Impact unavailable (HTTP ${result.status})`;
  else what = `Impact unreachable (${result.error || 'no response'})`;

  if (settings.offline_qr_enabled === true && job.kind === 'invoice' && !job.delayed_code && job.request) {
    job = await issueOffline(job, result.status === 408 ? 2 : 1, ctx);
  }

  return retryOrFail(job, what, result, settings);
}

/**
 * Offline issuance (Impact: Offline QR Code Instructions). The document is handed
 * over now with an offline QR and later transmitted unchanged with IsDelayedCode.
 * The exact request is frozen on the job so the QR signature stays valid.
 */
async function issueOffline(job, delayedCode, ctx) {
  const payload = { ...job.request, IsDelayedCode: delayedCode };
  const { url } = buildOfflineQr(payload, { apiKey: await ctx.impact.apiKey(), portalUrl: await ctx.impact.portalUrl() });
  return repo.updateJob(job.id, {
    delayed_code: delayedCode,
    request: payload,
    offline_qr_url: url,
    qr_url: url,
  });
}

async function retryOrFail(job, message, result, settings) {
  const max = Number(settings.retry_max_attempts) || 8;
  const offline = job.delayed_code ? ` Issued offline (Transmission Failure_${job.delayed_code}).` : '';

  if (job.attempts >= max) {
    return repo.updateJob(job.id, {
      status: 'failed',
      status_reason: `Gave up after ${job.attempts} attempts`,
      last_error: `${message}; gave up after ${job.attempts} attempts. Re-queue once resolved.${offline}`,
      last_error_detail: { status: result.status, error: result.error || null, body: result.body },
      writeback_pending: true,
    });
  }

  const delay = backoffSeconds(job.attempts, settings);
  return repo.updateJob(job.id, {
    status: 'retry',
    status_reason: `Attempt ${job.attempts} of ${max}`,
    last_error: `${message}; retrying (attempt ${job.attempts} of ${max}).${offline}`,
    last_error_detail: { status: result.status, error: result.error || null, body: result.body },
    next_attempt_at: new Date(Date.now() + delay * 1000),
    writeback_pending: true,
  });
}

/** Exponential backoff: base × 2^(attempt − 1), capped (FR-TX-04). */
export function backoffSeconds(attempts, settings) {
  const base = Number(settings.retry_base_seconds) || 340;
  const cap = Number(settings.retry_max_delay_seconds) || 21600;
  return Math.min(base * 2 ** Math.max(attempts - 1, 0), cap);
}

function pickDefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
}
