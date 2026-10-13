import { routeInvoice } from '../companies.js';
import * as repo from './repo.js';

/**
 * Queues a fully paid Storeganise invoice that has no job yet, under the company
 * it belongs to (scope §10.2). Shared by the webhook, the safety-net poll and the
 * reconciliation, so all three route the same way.
 *
 * `company` is the company whose webhook or poll found the invoice. In site mode
 * the invoice's site decides; an unmapped site gives a failed job that is never
 * sent. Returns { jobId, companyId, unmappedSite? }.
 */
export async function queuePaidInvoice({ cfg, company, invoiceId, siteId, event }) {
  const target = routeInvoice(cfg, company, siteId);

  if (!target) {
    const jobId = await repo.recordUnmappedSite(company.id, invoiceId, event, siteId);
    return { jobId, companyId: company.id, unmappedSite: siteId ?? null };
  }

  const jobId = await repo.enqueueInvoice(target.id, invoiceId, event, siteId);
  return { jobId, companyId: target.id };
}
