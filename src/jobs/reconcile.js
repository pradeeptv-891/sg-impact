import { pollAccounts, storeganiseFor } from '../companies.js';
import { many, one, query } from '../db.js';
import { yyyymmdd } from '../impact-api.js';
import { toCents } from '../mydata/money.js';
import { normalizeInvoice } from '../mydata/normalize.js';
import { isFullyPaid } from '../mydata/rules.js';
import { loadConfig } from '../settings.js';
import { queuePaidInvoice } from './capture.js';
import * as repo from './repo.js';

/**
 * FR-REC-01 nightly three-way reconciliation: Storeganise ↔ add-on ↔ Impact.
 *
 * Every finding is stored in einvoice.reconciliation_issues (see the
 * v_open_reconciliation_issues view). Two findings are fixed automatically: a
 * fully paid invoice with no job is queued, and a sent job missing its MARK gets it
 * from Impact. Everything else is left for an operator.
 *
 * The Storeganise step runs per account (scope §10), like the poll. The add-on
 * and Impact steps still cover every job against the one configured issuer; they
 * become per company with the Impact side.
 */
export async function runReconciliation({ sg, sgFor = sg ? () => sg : storeganiseFor, impact }) {
  const cfg = await loadConfig({ fresh: true });
  const { settings } = cfg;
  const windowTo = new Date();
  const windowFrom = new Date(windowTo.getTime() - (Number(settings.reconcile_lookback_days) || 3) * 86400000);
  const staleBefore = new Date(windowTo.getTime() - (Number(settings.reconcile_stale_minutes) || 60) * 60000);

  const run = await one(
    `insert into einvoice.reconciliation_runs (window_from, window_to) values ($1, $2) returning id`,
    [windowFrom, windowTo],
  );

  const issues = [];
  const add = (issue, fields = {}) => issues.push({ issue, ...fields });

  try {
    // --- 1. Storeganise: every fully paid invoice has a job ---------------------------
    let sgInvoiceCount = 0;
    let paidCount = 0;

    for (const { owner, companies } of pollAccounts(cfg)) {
      const sgInvoices = await listAll(sgFor(owner), windowFrom.toISOString(), Number(settings.poll_page_size) || 100);
      const paid = sgInvoices.filter(i => isFullyPaid(normalizeInvoice(i, settings), settings));
      sgInvoiceCount += sgInvoices.length;
      paidCount += paid.length;

      const jobsForPaid = new Map(
        (await repo.jobsByInvoiceIds(companies.map(c => c.id), paid.map(i => String(i.id)))).map(j => [j.sg_invoice_id, j]),
      );

      for (const invoice of paid) {
        if (jobsForPaid.has(String(invoice.id))) continue;
        const out = await queuePaidInvoice({
          cfg, company: owner, invoiceId: String(invoice.id), siteId: invoice.siteId || null, event: 'reconcile',
        });
        add('missing_job', {
          sg_invoice_id: String(invoice.id), job_id: out.jobId,
          details: { company: owner.code, state: invoice.state, action: out.unmappedSite !== undefined ? 'unmapped site' : 'queued' },
        });
      }
    }

    // --- 2. Add-on: jobs that should have gone out by now ------------------------------
    const jobs = await many(
      `select * from einvoice.jobs
        where created_at >= $1 or updated_at >= $1 or date_issued >= $1 or sent_at >= $1`,
      [windowFrom],
    );

    for (const job of jobs) {
      const base = { sg_invoice_id: job.sg_invoice_id, job_id: job.id, series_code: job.series_code, number: job.number };
      const details = { status: job.status, error: job.last_error, kind: job.kind };

      if (['failed', 'failed_data', 'held'].includes(job.status)) {
        add(job.number ? 'number_unsent' : 'failed_job', { ...base, details });
      } else if (['new', 'pending', 'retry', 'sending'].includes(job.status) && new Date(job.created_at) < staleBefore) {
        add(job.number ? 'number_unsent' : 'not_transmitted', { ...base, details });
      }
    }

    // --- 3. Impact: every sent document is there, once, with the same MARK/amount ------
    const docs = await impact.getAllDocuments({ from: yyyymmdd(windowFrom), to: yyyymmdd(windowTo) });

    if (!docs.ok) {
      add('impact_unavailable', { details: { status: docs.status || null, error: docs.error || null } });
    } else {
      const byKey = new Map();
      for (const doc of docs.documents) {
        const key = `${doc.series}|${Number(doc.number)}`;
        byKey.set(key, [...(byKey.get(key) || []), doc]);
      }

      // Jobs issued a little before the window too, so edge documents still match
      const numbered = await many(
        `select * from einvoice.jobs where date_issued >= $1 or (number is null and sent_at >= $1)`,
        [new Date(windowFrom.getTime() - 2 * 86400000)],
      );
      const jobByKey = new Map(numbered.filter(j => j.number).map(j => [`${j.series_code}|${Number(j.number)}`, j]));
      const jobByMark = new Map(numbered.filter(j => j.mark).map(j => [j.mark, j]));

      for (const [key, list] of byKey) {
        if (list.length > 1) {
          const [series, number] = key.split('|');
          add('duplicate_in_impact', { series_code: series, number: Number(number), details: { marks: list.map(d => d.mark) } });
        }
      }

      for (const job of numbered) {
        if (!['sent', 'credited'].includes(job.status) || !job.number) continue;
        if (new Date(job.date_issued) < windowFrom) continue;

        const base = { sg_invoice_id: job.sg_invoice_id, job_id: job.id, series_code: job.series_code, number: job.number };
        const doc = (byKey.get(`${job.series_code}|${Number(job.number)}`) || [])[0];

        if (!doc) {
          add('missing_in_impact', { ...base, details: { mark: job.mark } });
          continue;
        }

        if (!job.mark && doc.mark) {
          // Fill in identifiers Impact did not return at send time
          await repo.updateJob(job.id, {
            mark: doc.mark, uid: doc.uid, auth_code: doc.authCode, qr_url: doc.url,
            status_reason: 'Identifiers filled in by reconciliation', writeback_pending: true,
          });
          continue;
        }

        const problems = [];
        if (job.mark && doc.mark && job.mark !== doc.mark) problems.push(`MARK ${job.mark} vs Impact ${doc.mark}`);
        if (doc.totalAmount !== null && job.amount_gross !== null && Math.abs(toCents(doc.totalAmount) - toCents(job.amount_gross)) > 1) {
          problems.push(`amount ${job.amount_gross} vs Impact ${doc.totalAmount}`);
        }
        if (problems.length) add('mismatch', { ...base, details: { problems } });
      }

      for (const doc of docs.documents) {
        const known = jobByKey.has(`${doc.series}|${Number(doc.number)}`) || (doc.mark && jobByMark.has(doc.mark));
        if (!known) {
          add('unknown_in_impact', {
            series_code: doc.series, number: Number(doc.number) || null,
            details: { mark: doc.mark, dateIssued: doc.dateIssued, total: doc.totalAmount },
          });
        }
      }
    }

    for (const issue of issues) {
      await query(
        `insert into einvoice.reconciliation_issues (run_id, issue, sg_invoice_id, job_id, series_code, number, details)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [run.id, issue.issue, issue.sg_invoice_id || null, issue.job_id || null, issue.series_code || null,
          issue.number || null, JSON.stringify(issue.details || {})],
      );
    }

    const summary = {
      storeganiseInvoices: sgInvoiceCount,
      paid: paidCount,
      jobs: jobs.length,
      impactDocuments: docs.ok ? docs.documents.length : null,
      issues: countBy(issues, 'issue'),
    };

    await query(
      `update einvoice.reconciliation_runs set finished_at = now(), status = $2, summary = $3 where id = $1`,
      [run.id, issues.length ? 'issues' : 'ok', JSON.stringify(summary)],
    );
    return { runId: run.id, ...summary };
  } catch (err) {
    await query(
      `update einvoice.reconciliation_runs set finished_at = now(), status = 'error', error = $2 where id = $1`,
      [run.id, err.message],
    );
    throw err;
  }
}

async function listAll(sg, updatedAfter, limit) {
  const all = [];
  for (let offset = 0; ; offset += limit) {
    const page = await sg.listInvoices({ updatedAfter, limit, offset });
    all.push(...page);
    if (page.length < limit) return all;
  }
}

function countBy(rows, key) {
  return rows.reduce((acc, row) => ({ ...acc, [row[key]]: (acc[row[key]] || 0) + 1 }), {});
}
