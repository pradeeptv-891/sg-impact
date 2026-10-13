import { buildCreditNote } from '../mydata/credit-note.js';
import { toCents } from '../mydata/money.js';
import { resolveDocTypeRule, ruleForTypeCode } from '../mydata/rules.js';
import { validateDocument } from '../mydata/validate.js';
import { applyResult } from './transmit.js';
import { writeBack } from './writeback.js';
import * as repo from './repo.js';

/**
 * Credit-note job (FRD Module 6). Created by the invoice processor when an issued
 * invoice is voided, deleted or refunded; correlated to the original MARK and
 * numbered in its own series.
 */
export async function processCreditJob(job, ctx) {
  const { paused } = ctx;

  if (!['pending', 'retry', 'sending'].includes(job.status)) return { job };
  if (paused || new Date(job.next_attempt_at) > new Date()) return { job };

  const parent = await repo.getJob(job.parent_job_id);
  if (!parent || !['sent', 'credited'].includes(parent.status) || !parent.mark) {
    job = await repo.updateJob(job.id, {
      status: 'failed_data',
      last_error: 'Original document is not sent or has no MARK yet',
    });
    return { job };
  }

  const amountCents = toCents(job.credit_amount);
  job = await sendCreditDocument(job, parent, amountCents, ctx);

  if (job.status === 'sent') await afterCreditSent(parent, ctx);
  return { job };
}

async function sendCreditDocument(job, parent, amountCents, ctx) {
  const { cfg, impact } = ctx;
  const rule = job.invoice_type_code
    ? ruleForTypeCode('credit', job.invoice_type_code, cfg.docTypeRules)
    : resolveDocTypeRule({ kind: 'credit', customerKind: parent.customer_kind }, cfg.docTypeRules);

  const common = {
    original: parent.request,
    originalJob: parent,
    amountCents,
    rule,
    correctionKey: job.correction_key,
    reason: job.credit_reason,
  };

  const draft = buildCreditNote(common);
  if (!draft.ok) return failData(job, draft.errors.join('; '));
  const preErrors = validateDocument(draft.payload, { customerKind: parent.customer_kind, isCredit: true });
  if (preErrors.length) return failData(job, preErrors.join('; '));

  let numbering;
  try {
    numbering = await repo.reserveNumber(job.id, {
      series: job.series_code || rule.series_code,
      invoiceTypeCode: rule.invoice_type_code,
      customerKind: parent.customer_kind,
    });
  } catch (err) {
    return failData(job, err.message);
  }

  const built = buildCreditNote({
    ...common,
    numbering: { series: numbering.series_code, number: numbering.number, dateIssued: numbering.date_issued },
  });
  const errors = validateDocument(built.payload, { customerKind: parent.customer_kind, isCredit: true });
  if (errors.length) return failData(job, errors.join('; '));

  job = await repo.updateJob(job.id, {
    status: 'sending',
    attempts: job.attempts + 1,
    invoice_type_code: rule.invoice_type_code,
    request: built.payload,
    amount_net: built.totals.netCents / 100,
    amount_vat: built.totals.vatCents / 100,
    amount_gross: built.totals.grossCents / 100,
  });

  const result = await impact.sendDocument(built.payload, { jobId: job.id, sgInvoiceId: job.sg_invoice_id });
  return applyResult(job, result, ctx);
}

/** Marks the original as credited once fully credited, and refreshes its ei_* fields. */
async function afterCreditSent(parent, ctx) {
  const credits = await repo.creditJobsFor(parent.id);
  const sentTotal = credits.filter(c => c.status === 'sent').reduce((t, c) => t + toCents(c.credit_amount), 0);
  const fully = sentTotal >= toCents(parent.amount_gross);

  let updated = await repo.updateJob(parent.id, {
    ...(fully && parent.status === 'sent' && { status: 'credited', status_reason: 'Fully credited' }),
    credit_required: null,
    writeback_pending: true,
  });
  updated = await writeBack(updated, { sg: ctx.sg });
  return updated;
}

function failData(job, message) {
  return repo.updateJob(job.id, {
    status: 'failed_data',
    status_reason: 'Failed validation before sending',
    last_error: message,
  });
}
