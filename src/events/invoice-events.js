import * as repo from '../jobs/repo.js';
import { normalizeInvoice } from '../mydata/normalize.js';
import { isFullyPaid } from '../mydata/rules.js';
import { loadConfig } from '../settings.js';

/**
 * Handler for Storeganise invoice events (FR-CAP-01 / 02).
 *
 *   invoice.state.updated    → { invoiceId, siteId, from, to }
 *   invoice.payments.updated → { invoiceId, siteId, addedIds }
 *   invoice.deleted          → { invoiceId, siteId }
 *
 * FRD v1.3: an unpaid invoice is a pro forma, so no job exists until it is fully
 * paid. Webhooks carry ids only, so for an invoice the add-on does not track yet
 * the invoice is read back here (one Storeganise call, well inside the 30s limit)
 * and a job is created only if it is fully paid. If Storeganise cannot be reached
 * this throws, the webhook answers 500 and Storeganise retries; the safety-net poll
 * covers anything still missed.
 *
 * For an invoice that already has a job (paid, maybe sent), every event just flags
 * the job; the worker re-reads it and handles refunds, voids and deletes after issue.
 */
export default async function invoiceEvent({ event, data, sg }) {
  const { invoiceId } = data || {};
  if (!invoiceId) return { skipped: 'no invoiceId' };
  const id = String(invoiceId);

  if (await repo.getInvoiceJob(id)) {
    const jobId = await repo.enqueueInvoice(id, event, data.siteId || null);
    return { queued: true, invoiceId: id, jobId };
  }

  // Never paid, so never sent: nothing to credit
  if (event === 'invoice.deleted') return { ignored: 'invoice was never paid', invoiceId: id };

  const raw = await sg.getInvoice(id);
  if (!raw) return { ignored: 'invoice not found in Storeganise', invoiceId: id };

  const { settings } = await loadConfig();
  const invoice = normalizeInvoice(raw, settings);
  if (!isFullyPaid(invoice, settings)) {
    return { ignored: 'not fully paid', invoiceId: id, state: invoice.state, balance: raw.balance ?? null };
  }

  const jobId = await repo.enqueueInvoice(id, event, invoice.siteId || data.siteId || null);
  return { queued: true, invoiceId: id, jobId };
}
