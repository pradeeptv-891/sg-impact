import { many, one, query } from '../db.js';

/**
 * All SQL touching einvoice.jobs lives here.
 */

const JSON_COLUMNS = new Set(['last_error_detail', 'sg_snapshot', 'request', 'response', 'written_back']);

export async function enqueueInvoice(companyId, sgInvoiceId, event, sgSiteId = null) {
  const row = await one(
    'select einvoice.enqueue_invoice($1, $2, $3, $4) as id',
    [companyId, String(sgInvoiceId), event, sgSiteId == null ? null : String(sgSiteId)],
  );
  return row.id;
}

/**
 * routing_mode = 'site', site not mapped to any company (scope §10.2): a failed
 * job under the company that found it, so it shows in v_attention and is never
 * sent. einvoice.reroute_unmapped_job() moves it once the site is mapped.
 */
export async function recordUnmappedSite(companyId, sgInvoiceId, event, sgSiteId) {
  const site = sgSiteId == null ? null : String(sgSiteId);
  const row = await one(
    `insert into einvoice.jobs
       (company_id, sg_invoice_id, sg_site_id, status, status_reason, last_error, needs_eval, last_event, last_event_at)
     values ($1, $2, $3, 'failed', 'unmapped_site', $4, false, $5, now())
     on conflict (company_id, sg_invoice_id, kind, correction_key) do update
        set last_event = excluded.last_event, last_event_at = excluded.last_event_at
     returning id`,
    [companyId, String(sgInvoiceId), site, `Unmapped site ${site ?? '(none)'}: add it to einvoice.company_sites`, event],
  );
  return row.id;
}

export async function claimJobs({ limit, leaseSeconds, transmit }) {
  return many('select * from einvoice.claim_jobs($1, $2, $3)', [limit, leaseSeconds, transmit]);
}

export async function getJob(id) {
  return one('select * from einvoice.jobs where id = $1', [id]);
}

/** Flags a customer's held invoices for re-evaluation (user.updated). */
export async function recheckCustomer(companyIds, sgOwnerId) {
  const row = await one('select einvoice.recheck_customer($1, $2) as n', [companyIds, String(sgOwnerId)]);
  return row.n;
}

/** The invoice job for a Storeganise invoice, among the given companies (one account). */
export async function getInvoiceJob(companyIds, sgInvoiceId) {
  return one(
    `select * from einvoice.jobs where company_id = any($1) and sg_invoice_id = $2 and kind = 'invoice'`,
    [companyIds, String(sgInvoiceId)],
  );
}

export async function creditJobsFor(parentJobId) {
  return many(`select * from einvoice.jobs where parent_job_id = $1 order by created_at`, [parentJobId]);
}

/** Clears needs_eval just before the invoice is re-read (see claim_jobs). */
export async function clearNeedsEval(id) {
  await query('update einvoice.jobs set needs_eval = false where id = $1', [id]);
}

/**
 * Applies `patch` to a job. The job's lease is left alone: the worker holds it for
 * the whole of processing and releases it at the end (see release / park).
 */
export async function updateJob(id, patch) {
  const columns = Object.keys(patch);
  if (!columns.length) return getJob(id);
  const values = columns.map(c => (JSON_COLUMNS.has(c) && patch[c] !== null ? JSON.stringify(patch[c]) : patch[c]));
  const sets = columns.map((c, i) => `${c} = $${i + 2}`);

  return one(`update einvoice.jobs set ${sets.join(', ')} where id = $1 returning *`, [id, ...values]);
}

/**
 * Extends the lease on a claimed job just before it is processed. Fails (returns
 * false) if the lease lapsed and another run has since claimed the job, which is
 * detected by its lease_token no longer being the one this run was given.
 */
export async function renewLease(id, leaseToken, seconds) {
  const row = await one(
    `update einvoice.jobs set locked_until = now() + make_interval(secs => $3)
      where id = $1 and lease_token = $2
     returning id`,
    [id, leaseToken, Number(seconds)],
  );
  return Boolean(row);
}

/** Ends the worker's lease so the job can be claimed again. */
export async function release(id) {
  await query('update einvoice.jobs set locked_until = null where id = $1', [id]);
}

/** Keeps a job out of the queue for a while, e.g. after a Storeganise outage. */
export async function park(id, seconds) {
  await query(
    'update einvoice.jobs set locked_until = now() + make_interval(secs => $2) where id = $1',
    [id, Number(seconds)],
  );
}

/** FR-NUM-01/02: reserve (or re-read) the job's number. */
export async function reserveNumber(jobId, { series, invoiceTypeCode, customerKind }) {
  return one(
    'select * from einvoice.reserve_job_number($1, $2, $3, $4)',
    [jobId, series, invoiceTypeCode, customerKind],
  );
}

/**
 * Creates a credit-note job for an original, once per correction key. Returns the
 * new job, or null if one already existed.
 */
export async function createCreditJob({ parent, correctionKey, amountCents, reason }) {
  return one(
    `insert into einvoice.jobs
       (kind, company_id, sg_invoice_id, correction_key, parent_job_id, sg_site_id, status, needs_eval,
        customer_kind, credit_amount, credit_reason, next_attempt_at)
     values ('credit_note', $8, $1, $2, $3, $4, 'pending', false, $5, $6, $7, now())
     on conflict (company_id, sg_invoice_id, kind, correction_key) do nothing
     returning *`,
    [parent.sg_invoice_id, correctionKey, parent.id, parent.sg_site_id, parent.customer_kind, amountCents / 100, reason, parent.company_id],
  );
}

export async function jobsByInvoiceIds(companyIds, ids) {
  if (!ids.length) return [];
  return many(
    `select * from einvoice.jobs where kind = 'invoice' and company_id = any($1) and sg_invoice_id = any($2)`,
    [companyIds, ids],
  );
}
