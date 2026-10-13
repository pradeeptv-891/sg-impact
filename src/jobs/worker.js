import { audit } from '../audit.js';
import { companyById, storeganiseFor } from '../companies.js';
import * as impactApi from '../impact-api.js';
import { loadConfig } from '../settings.js';
import { processCreditJob } from './process-credit.js';
import { processInvoiceJob } from './process-invoice.js';
import * as repo from './repo.js';

/**
 * Transmission Worker (FRD 2.2). Triggered every minute by pg_cron, and nudged
 * after each webhook. Claims a small batch so a run fits comfortably inside the
 * lease and processes jobs one at a time (Storeganise wants serial API calls).
 *
 * Each job is read and written back through its own company's Storeganise client
 * (scope §10). Inactive companies' jobs are never claimed; a paused company's jobs
 * are evaluated but not transmitted (FR-CFG-05), as with the global kill switch.
 *
 * `sgFor(company)` gives a company's client; tests may pass a single `sg` instead.
 */
export function defaultContext() {
  return { sgFor: storeganiseFor, impact: impactApi };
}

export async function runWorker(base = defaultContext()) {
  const cfg = await loadConfig({ fresh: true });
  const settings = cfg.settings;
  const paused = settings.transmission_paused === true;
  const leaseSeconds = Number(settings.worker_lease_seconds) || 300;
  const { sg, sgFor = () => sg, ...rest } = base;
  const ctx = { ...rest, cfg, paused };

  const summary = { claimed: 0, processed: 0, skipped: 0, errors: 0, statuses: {}, paused };

  if (!cfg.issuer) {
    // Nothing can be issued without the issuer; jobs keep queueing meanwhile
    summary.note = 'Issuer not configured (einvoice.issuer); nothing processed';
    return summary;
  }

  const jobs = await repo.claimJobs({
    limit: Number(settings.worker_batch_size) || 25,
    leaseSeconds,
    transmit: !paused,
  });
  summary.claimed = jobs.length;

  for (const job of jobs) {
    // Re-take the lease just before starting; if an earlier job ran long and this
    // one's lease lapsed and was claimed by another run, leave it to that run.
    if (!await repo.renewLease(job.id, job.lease_token, leaseSeconds)) {
      summary.skipped++;
      continue;
    }

    let parkFor = null;
    try {
      const company = companyById(cfg, job.company_id);
      const jobCtx = { ...ctx, company, sg: sgFor(company), paused: paused || company.paused };
      const out = job.kind === 'credit_note'
        ? await processCreditJob(job, jobCtx)
        : await processInvoiceJob(job, jobCtx);
      parkFor = out?.parkFor || null;
      const status = out?.job?.status || job.status;
      summary.statuses[status] = (summary.statuses[status] || 0) + 1;
      summary.processed++;
    } catch (err) {
      summary.errors++;
      console.error('Worker error', { job: job.id, invoice: job.sg_invoice_id, message: err.message });
      await audit({ kind: 'system', jobId: job.id, sgInvoiceId: job.sg_invoice_id, method: 'worker', error: err.stack || err.message });
      await repo.updateJob(job.id, { needs_eval: job.kind === 'invoice', status_reason: `Internal error: ${err.message}` })
        .catch(() => {});
      parkFor = 300;
    } finally {
      await (parkFor ? repo.park(job.id, parkFor) : repo.release(job.id)).catch(() => {});
    }
  }

  return summary;
}
