import { audit } from '../audit.js';
import { companyById, storeganiseFor } from '../companies.js';
import { impactFor } from '../impact-api.js';
import { forCompany, loadConfig } from '../settings.js';
import { processCreditJob } from './process-credit.js';
import { processInvoiceJob } from './process-invoice.js';
import * as repo from './repo.js';

/**
 * Transmission Worker (FRD 2.2). Triggered every minute by pg_cron, and nudged
 * after each webhook. Claims a small batch so a run fits comfortably inside the
 * lease and processes jobs one at a time (Storeganise wants serial API calls).
 *
 * Each job is processed with its own company's configuration (issuer, series,
 * mapping), read and written back through its company's Storeganise client, and
 * sent with its company's Impact client (scope §10). Inactive companies' jobs are
 * never claimed; a paused company's jobs are evaluated but not transmitted
 * (FR-CFG-05), as with the global kill switch. So are the jobs of a company whose
 * Impact API key is not configured yet. Without an issuer, a company's jobs are
 * left queued untouched (they cannot even be mapped).
 *
 * `sgFor(company)` / `impactFor(company)` give a company's clients; tests may pass
 * a single `sg` / `impact` instead.
 */
export function defaultContext() {
  return { sgFor: storeganiseFor, impactFor };
}

// A company that cannot send yet is looked at again after this long
const NOT_READY_PARK_SECONDS = 900;

export async function runWorker(base = defaultContext()) {
  const cfg = await loadConfig({ fresh: true });
  const settings = cfg.settings;
  const paused = settings.transmission_paused === true;
  const leaseSeconds = Number(settings.worker_lease_seconds) || 300;
  const { sg, sgFor = () => sg, impact, impactFor: clientFor = () => impact, ...rest } = base;
  const ctx = { ...rest, paused };

  const summary = { claimed: 0, processed: 0, skipped: 0, errors: 0, statuses: {}, paused, notReady: {} };

  // Per company, once per run: why it cannot send yet (null = ready)
  const readiness = new Map();
  const notReadyReason = async (company, client) => {
    if (!readiness.has(company.id)) {
      readiness.set(company.id, client.notReady ? await client.notReady() : null);
    }
    return readiness.get(company.id);
  };

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
      const companyCfg = forCompany(cfg, company);
      const client = clientFor(company);

      if (!companyCfg.issuer) {
        // Nothing can be mapped without the issuer; the job waits untouched
        summary.notReady[company.code] = `Issuer not configured for company ${company.code} (einvoice.issuer)`;
        summary.skipped++;
        parkFor = NOT_READY_PARK_SECONDS;
        continue;
      }

      const notReady = await notReadyReason(company, client);
      if (notReady) summary.notReady[company.code] = notReady;

      const jobCtx = {
        ...ctx, cfg: companyCfg, company, sg: sgFor(company), impact: client,
        paused: paused || company.paused || Boolean(notReady),
      };
      const out = job.kind === 'credit_note'
        ? await processCreditJob(job, jobCtx)
        : await processInvoiceJob(job, jobCtx);
      parkFor = out?.parkFor || null;

      if (notReady && !parkFor && ['pending', 'retry', 'sending'].includes(out?.job?.status)) {
        // Ready to go but cannot be sent: say why, and do not pick it up every minute
        if (out.job.status_reason !== notReady) await repo.updateJob(job.id, { status_reason: notReady });
        parkFor = NOT_READY_PARK_SECONDS;
      }

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
