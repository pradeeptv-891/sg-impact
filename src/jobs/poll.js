import { normalizeInvoice } from '../mydata/normalize.js';
import { isFullyPaid } from '../mydata/rules.js';
import { getState, loadConfig, setState } from '../settings.js';
import * as repo from './repo.js';

/**
 * FR-CAP-04 safety net: every 10–15 minutes, list invoices changed since the last
 * run and queue anything a webhook did not already cover. As with webhooks, an
 * invoice gets a job only once it is fully paid (FRD v1.3). Storeganise drops a
 * webhook after two failed deliveries, so this is what guarantees nothing is missed.
 */
export async function runPoll({ sg }) {
  const { settings } = await loadConfig();
  const startedAt = new Date();
  const overlapMs = (Number(settings.poll_overlap_seconds) || 300) * 1000;
  const limit = Number(settings.poll_page_size) || 100;

  const cursor = await getState('poll_cursor');
  // First ever run looks back a day; go-live back-filling is out of scope (FRD 1.2)
  const since = cursor ? new Date(cursor) : new Date(startedAt.getTime() - 24 * 3600 * 1000);
  const updatedAfter = new Date(since.getTime() - overlapMs).toISOString();

  let offset = 0;
  let seen = 0;
  let queued = 0;

  for (;;) {
    const invoices = await sg.listInvoices({ updatedAfter, limit, offset });
    seen += invoices.length;

    const existing = new Map((await repo.jobsByInvoiceIds(invoices.map(i => String(i.id)))).map(j => [j.sg_invoice_id, j]));

    for (const invoice of invoices) {
      const id = String(invoice.id);
      const job = existing.get(id);

      if (!job) {
        // Unpaid and partly paid invoices are pro formas: no job (FR-CAP-03)
        if (!isFullyPaid(normalizeInvoice(invoice, settings), settings)) continue;
        await repo.enqueueInvoice(id, 'poll', invoice.siteId || null);
        queued++;
        continue;
      }

      // Already seen through a webhook since this change
      const updated = invoice.updated ? new Date(invoice.updated) : null;
      if (updated && job.last_event_at && new Date(job.last_event_at) >= updated) continue;

      await repo.enqueueInvoice(id, 'poll', invoice.siteId || null);
      queued++;
    }

    if (invoices.length < limit) break;
    offset += limit;
  }

  await setState('poll_cursor', startedAt.toISOString());
  return { updatedAfter, seen, queued };
}
