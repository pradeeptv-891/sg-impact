import { accountCompanies } from '../companies.js';
import { queuePaidInvoice } from '../jobs/capture.js';
import * as repo from '../jobs/repo.js';
import { normalizeInvoice } from '../mydata/normalize.js';
import { isFullyPaid } from '../mydata/rules.js';

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
 *
 * `company` is the company whose webhook URL was called; `sg` is its client.
 * `deadline` bounds the Storeganise read so the webhook answers in time.
 */
export default async function invoiceEvent({ event, data, sg, company, cfg, deadline }) {
  const { invoiceId } = data || {};
  if (!invoiceId) return { skipped: 'no invoiceId' };
  const id = String(invoiceId);

  // In site mode the job may belong to another company on the same account
  const account = accountCompanies(cfg, company).map(c => c.id);
  const tracked = await repo.getInvoiceJob(account, id);
  if (tracked) {
    const jobId = await repo.enqueueInvoice(tracked.company_id, id, event, data.siteId || null);
    return { queued: true, invoiceId: id, jobId, companyId: tracked.company_id };
  }

  // Never paid, so never sent: nothing to credit
  if (event === 'invoice.deleted') return { ignored: 'invoice was never paid', invoiceId: id };

  const raw = await sg.getInvoice(id, { deadline });
  if (!raw) return { ignored: 'invoice not found in Storeganise', invoiceId: id };

  const invoice = normalizeInvoice(raw, cfg.settings);
  if (!isFullyPaid(invoice, cfg.settings)) {
    return { ignored: 'not fully paid', invoiceId: id, state: invoice.state, balance: raw.balance ?? null };
  }

  const out = await queuePaidInvoice({ cfg, company, invoiceId: id, siteId: invoice.siteId || data.siteId || null, event });
  if (out.unmappedSite !== undefined) {
    return { failed: 'unmapped site', invoiceId: id, siteId: out.unmappedSite, jobId: out.jobId, companyId: out.companyId };
  }
  return { queued: true, invoiceId: id, jobId: out.jobId, companyId: out.companyId };
}
