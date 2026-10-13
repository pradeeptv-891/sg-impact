import { pollAccounts, storeganiseFor } from '../companies.js';
import { normalizeInvoice } from '../mydata/normalize.js';
import { isFullyPaid } from '../mydata/rules.js';
import { getState, loadConfig, setState } from '../settings.js';
import { queuePaidInvoice } from './capture.js';
import * as repo from './repo.js';

/**
 * FR-CAP-04 safety net: every 10–15 minutes, list invoices changed since the last
 * run and queue anything a webhook did not already cover. As with webhooks, an
 * invoice gets a job only once it is fully paid (FRD v1.3). Storeganise drops a
 * webhook after two failed deliveries, so this is what guarantees nothing is missed.
 *
 * Runs once per Storeganise account (scope §10): a company with its own account,
 * or the companies sharing one in site mode, each with its own cursor. One
 * account failing does not stop the others; its cursor stays put and the next run
 * covers the gap.
 *
 * `sgFor(company)` gives a company's client; tests may pass a single `sg` instead.
 */
export async function runPoll({ sg, sgFor = sg ? () => sg : storeganiseFor }) {
  const cfg = await loadConfig({ fresh: true });
  const result = { seen: 0, queued: 0, accounts: {} };

  for (const account of pollAccounts(cfg)) {
    try {
      const out = await pollAccount(cfg, account, sgFor(account.owner));
      result.accounts[account.owner.code] = out;
      result.seen += out.seen;
      result.queued += out.queued;
    } catch (err) {
      console.error('Poll failed', { company: account.owner.code, message: err.message });
      result.accounts[account.owner.code] = { error: err.message };
    }
  }

  return result;
}

async function pollAccount(cfg, { owner, companies }, sg) {
  const { settings } = cfg;
  const startedAt = new Date();
  const overlapMs = (Number(settings.poll_overlap_seconds) || 300) * 1000;
  const limit = Number(settings.poll_page_size) || 100;
  const cursorKey = `poll_cursor:${owner.code}`;
  const companyIds = companies.map(c => c.id);

  const cursor = await getState(cursorKey);
  // First ever run looks back a day; go-live back-filling is out of scope (FRD 1.2)
  const since = cursor ? new Date(cursor) : new Date(startedAt.getTime() - 24 * 3600 * 1000);
  const updatedAfter = new Date(since.getTime() - overlapMs).toISOString();

  let offset = 0;
  let seen = 0;
  let queued = 0;
  let unmapped = 0;

  for (;;) {
    const invoices = await sg.listInvoices({ updatedAfter, limit, offset });
    seen += invoices.length;

    const ids = invoices.map(i => String(i.id));
    const existing = new Map((await repo.jobsByInvoiceIds(companyIds, ids)).map(j => [j.sg_invoice_id, j]));

    for (const invoice of invoices) {
      const id = String(invoice.id);
      const job = existing.get(id);

      if (!job) {
        // Unpaid and partly paid invoices are pro formas: no job (FR-CAP-03)
        if (!isFullyPaid(normalizeInvoice(invoice, settings), settings)) continue;
        const out = await queuePaidInvoice({ cfg, company: owner, invoiceId: id, siteId: invoice.siteId || null, event: 'poll' });
        if (out.unmappedSite !== undefined) unmapped++;
        else queued++;
        continue;
      }

      // Already seen through a webhook since this change
      const updated = invoice.updated ? new Date(invoice.updated) : null;
      if (updated && job.last_event_at && new Date(job.last_event_at) >= updated) continue;

      await repo.enqueueInvoice(job.company_id, id, 'poll', invoice.siteId || null);
      queued++;
    }

    if (invoices.length < limit) break;
    offset += limit;
  }

  await setState(cursorKey, startedAt.toISOString());
  return { updatedAfter, seen, queued, ...(unmapped && { unmappedSite: unmapped }) };
}
