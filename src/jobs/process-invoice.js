import { routeInvoice } from '../companies.js';
import { buildDocument } from '../mydata/mapper.js';
import { fingerprint, normalizeCustomer, normalizeInvoice } from '../mydata/normalize.js';
import { businessCustomerProblems, customerKind, isFullyPaid } from '../mydata/rules.js';
import { formatEuros, toCents } from '../mydata/money.js';
import { validateDocument } from '../mydata/validate.js';
import { applyResult } from './transmit.js';
import { writeBack } from './writeback.js';
import * as repo from './repo.js';

// A held invoice (missing customer tax data) is re-checked at once on user.updated
// (see events/user-events.js), and also this often in case that webhook is missed.
const HELD_RECHECK_SECONDS = 3600;

const ISSUED = ['sent', 'credited'];
const TRANSMITTABLE = ['pending', 'retry', 'sending'];

/**
 * One invoice job, end to end: read the invoice, decide eligibility, reserve a
 * number, transmit, record the result, handle post-issue changes, write back.
 *
 * `ctx` = { cfg, company, sg, impact, paused }; `sg` is the job's company's
 * client. Returns { job, parkFor? }.
 */
export async function processInvoiceJob(job, ctx) {
  const { cfg, sg } = ctx;
  const settings = cfg.settings;

  // Only an operator re-queue moves these on (FRD 5.3)
  if (job.status === 'failed' || job.status === 'failed_data') {
    return finish(job, ctx);
  }

  if (job.needs_eval) await repo.clearNeedsEval(job.id);

  // --- Read the invoice back (webhooks carry ids only) --------------------------
  let raw;
  let owner;
  try {
    raw = await sg.getInvoice(job.sg_invoice_id);
    if (raw) owner = await loadOwner(raw, sg);
  } catch (err) {
    // Storeganise is down or refused: try again in a couple of minutes
    await repo.updateJob(job.id, { needs_eval: true, status_reason: `Storeganise read failed: ${err.message}` });
    return { job, parkFor: err.permanent ? 900 : 120 };
  }

  let deleted = false;
  if (!raw) {
    deleted = true;
    if (job.number === null && !ISSUED.includes(job.status)) {
      // Nothing reserved, nothing sent: close the job (FRD 5.5, invoice.deleted)
      job = await repo.updateJob(job.id, { status: 'skipped', status_reason: 'Invoice deleted before issue', last_error: null });
      return { job };
    }
    // Deleted after a number was reserved or the document sent: carry on from the
    // snapshot so the series stays continuous, then credit it (FR-NUM-03).
    raw = job.sg_snapshot?.invoice;
    owner = job.sg_snapshot?.owner;
    if (!raw) {
      job = await repo.updateJob(job.id, {
        status: 'failed',
        last_error: 'Invoice deleted in Storeganise after its number was reserved, and no snapshot exists',
      });
      return { job };
    }
  }

  const invoice = normalizeInvoice(raw, settings);
  const customer = normalizeCustomer(owner);
  const voided = deleted || (settings.sg_void_states || []).includes(invoice.state);
  const customFields = deleted ? null : raw.customFields || {};

  if (job.sg_site_id === null && invoice.siteId) {
    job = await repo.updateJob(job.id, { sg_site_id: invoice.siteId });
  }
  // Remembered so user.updated can re-check this customer's held invoices
  const ownerId = customer?.id ?? invoice.ownerId;
  if (ownerId && job.sg_owner_id !== String(ownerId)) {
    job = await repo.updateJob(job.id, { sg_owner_id: String(ownerId) });
  }

  // Isolation guard (scope §10.3): in site mode, never issue another company's
  // invoice, e.g. after a site was re-mapped or an unmapped-site job was re-queued.
  if (ctx.company?.routing_mode === 'site' && job.number === null && !ISSUED.includes(job.status)) {
    const owner = routeInvoice(cfg, ctx.company, invoice.siteId);
    if (owner?.id !== ctx.company.id) {
      const reason = owner
        ? `Invoice site ${invoice.siteId} belongs to company ${owner.code}, not ${ctx.company.code}`
        : `Unmapped site ${invoice.siteId ?? '(none)'}: add it to einvoice.company_sites`;
      job = await repo.updateJob(job.id, {
        status: 'failed', status_reason: owner ? 'wrong_company' : 'unmapped_site', last_error: reason,
      });
      return { job };
    }
  }

  // --- Already issued: only look for changes, voids and refunds -------------------
  if (ISSUED.includes(job.status)) {
    if (job.status === 'sent' && !job.mark && !ctx.paused && new Date(job.next_attempt_at) <= new Date()) {
      job = await followUpMark(job, ctx);
    }
    job = await postIssue(job, invoice, { deleted, voided, ctx });
    return finish(job, ctx, customFields);
  }

  // --- Eligibility (only until a number is reserved; after that it must be sent) ----
  let build = null;
  if (job.number === null) {
    const decision = evaluate(invoice, customer, cfg, job);
    build = decision.build;

    if (decision.status !== 'pending') {
      job = await repo.updateJob(job.id, {
        status: decision.status,
        status_reason: decision.reason,
        last_error: ['held', 'failed_data'].includes(decision.status) ? decision.reason : null,
        customer_kind: decision.customerKind || job.customer_kind,
        ...(decision.status === 'held' && { next_attempt_at: new Date(Date.now() + HELD_RECHECK_SECONDS * 1000) }),
        writeback_pending: job.status !== decision.status || job.last_error !== decision.reason,
      });
      return finish(job, ctx, customFields);
    }

    if (!TRANSMITTABLE.includes(job.status)) {
      job = await repo.updateJob(job.id, {
        status: 'pending',
        status_reason: null,
        last_error: null,
        attempts: 0,
        next_attempt_at: new Date(),
        customer_kind: decision.customerKind,
        writeback_pending: true,
      });
    }
  }

  // --- Transmission ---------------------------------------------------------------
  if (ctx.paused) return finish(job, ctx, customFields);
  if (new Date(job.next_attempt_at) > new Date()) return finish(job, ctx, customFields);

  job = await transmitInvoice(job, { invoice, customer, raw, owner, build }, ctx);

  if (job.status === 'sent' && voided) {
    job = await postIssue(job, invoice, { deleted, voided, ctx });
  }

  return finish(job, ctx, customFields);
}

/**
 * FR-CAP-03 / FR-CAP-05 / FR-CUS-02 / FR-MAP-07 before any number is reserved.
 * Every document type is sent only once the invoice is fully paid.
 * Returns { status, reason, build, customerKind }.
 */
export function evaluate(invoice, customer, cfg, job = {}) {
  const settings = cfg.settings;

  if ((settings.sg_void_states || []).includes(invoice.state)) {
    return { status: 'skipped', reason: `Invoice ${invoice.state} before issue` };
  }

  // Jobs are only created for fully paid invoices, but a payment can be reversed
  // before the worker gets to it. Never send it then (FRD v1.3, FR-CAP-03/05); a
  // later payment event re-evaluates the job.
  if (!isFullyPaid(invoice, settings)) {
    const balance = invoice.balanceCents === null ? '' : `, balance ${formatEuros(invoice.balanceCents)}`;
    return { status: 'skipped', reason: `Not fully paid (${invoice.state || 'draft'}${balance})` };
  }

  if (!customer) return { status: 'held', reason: 'Invoice has no customer' };

  // A negative document is a Storeganise credit note. Its myDATA treatment (a credit
  // note correlated to the original invoice's MARK) is not wired up yet: hold it so
  // it is visible rather than sent as an invoice.
  if (invoice.totalCents < 0) {
    return { status: 'held', reason: 'Storeganise credit note (negative total): issue the correction from the original invoice' };
  }

  // Nothing to report: decided before mapping, so an unmappable line on a €0
  // invoice (e.g. rent fully offset by a credit) does not make it fail
  if (invoice.totalCents === 0 && settings.zero_value_policy !== 'send') {
    return { status: 'skipped', reason: 'Zero-value invoice' };
  }

  const kind = customerKind(customer);
  if (kind === 'b2b') {
    // Held, never downgraded to a B2C receipt (FR-CUS-02)
    const problems = businessCustomerProblems(customer);
    if (problems.length) return { status: 'held', reason: problems.join('; '), customerKind: kind };
  }

  const build = buildDocument({ invoice, customer, config: cfg, job });
  if (!build.ok) {
    if (build.meta.noReportableLines) return { status: 'skipped', reason: 'No reportable lines (e.g. deposit only)', customerKind: kind };
    return { status: 'failed_data', reason: build.errors.join('; '), customerKind: kind };
  }

  if (build.meta.totals.grossCents === 0 && settings.zero_value_policy !== 'send') {
    return { status: 'skipped', reason: 'Zero-value invoice', customerKind: kind };
  }

  return { status: 'pending', reason: null, build, customerKind: kind };
}

async function transmitInvoice(job, { invoice, customer, raw, owner, build }, ctx) {
  const { cfg, impact } = ctx;

  // Issued offline: the exact document behind the offline QR must be sent, unchanged
  if (job.delayed_code && job.request) {
    job = await repo.updateJob(job.id, { status: 'sending', attempts: job.attempts + 1 });
    const result = await impact.sendDocument(job.request, { jobId: job.id, sgInvoiceId: job.sg_invoice_id });
    return applyResult(job, result, ctx);
  }

  // A job with a reserved number skipped evaluation; build it now with the locked
  // document type and series.
  if (!build) build = buildDocument({ invoice, customer, config: cfg, job });
  if (!build.ok) return failData(job, build.errors.join('; '));

  // Validate before reserving, so rejected documents never consume numbers
  const preErrors = validateDocument(build.payload, { customerKind: build.meta.customerKind });
  if (preErrors.length) return failData(job, preErrors.join('; '));

  // --- Reserve-before-send (FR-NUM-02) -----------------------------------------------
  let numbering;
  try {
    numbering = await repo.reserveNumber(job.id, {
      series: build.meta.seriesCode,
      invoiceTypeCode: build.meta.rule.invoice_type_code,
      customerKind: build.meta.customerKind,
    });
  } catch (err) {
    return failData(job, err.message);
  }

  job = await repo.updateJob(job.id, {
    invoice_type_code: job.invoice_type_code || build.meta.rule.invoice_type_code,
    customer_kind: job.customer_kind || build.meta.customerKind,
    ...(!job.sg_snapshot && { sg_snapshot: { invoice: raw, owner } }),
  });

  const final = buildDocument({
    invoice,
    customer,
    config: cfg,
    job,
    numbering: { number: numbering.number, dateIssued: numbering.date_issued },
  });
  if (!final.ok) return failData(job, final.errors.join('; '));

  const errors = validateDocument(final.payload, { customerKind: job.customer_kind });
  if (errors.length) return failData(job, errors.join('; '));

  const { totals } = final.meta;
  job = await repo.updateJob(job.id, {
    status: 'sending',
    attempts: job.attempts + 1,
    request: final.payload,
    sg_fingerprint: fingerprint(invoice),
    amount_net: totals.netCents / 100,
    amount_vat: totals.vatCents / 100,
    amount_gross: totals.grossCents / 100,
  });

  const result = await impact.sendDocument(final.payload, { jobId: job.id, sgInvoiceId: job.sg_invoice_id });
  return applyResult(job, result, ctx);
}

function failData(job, message) {
  return repo.updateJob(job.id, {
    status: 'failed_data',
    status_reason: 'Failed validation before sending',
    last_error: message,
    writeback_pending: true,
  });
}

/**
 * FRD Module 6 on an already-issued invoice:
 *   - amounts changed → flag only, never re-send (FR-COR-03)
 *   - refunds → partial credit note (FR-COR-02)
 *   - voided / deleted → full credit note for whatever is not yet credited (FR-COR-01)
 * With credit notes disabled, the need for one is flagged on the invoice instead.
 */
async function postIssue(job, invoice, { deleted, voided, ctx }) {
  const settings = ctx.cfg.settings;
  const patch = {};

  if (!voided && job.sg_fingerprint && fingerprint(invoice) !== job.sg_fingerprint && !job.changed_after_issue) {
    patch.changed_after_issue = true;
  }

  if (job.status === 'sent') {
    const gross = toCents(job.amount_gross);
    const credits = await repo.creditJobsFor(job.id);
    let credited = credits
      .filter(c => !['skipped', 'cancelled'].includes(c.status))
      .reduce((total, c) => total + toCents(c.credit_amount), 0);

    const handled = [...(job.handled_refunds || [])];
    const needed = [];

    for (const refund of invoice.payments.filter(p => p.isRefund && p.id && !handled.includes(p.id))) {
      const remaining = gross - credited;
      if (remaining <= 0) {
        handled.push(refund.id);
        continue;
      }
      const amount = Math.min(Math.abs(refund.amountCents), remaining);
      const isFull = amount === gross;
      const enabled = isFull ? settings.credit_notes_enabled === true : settings.partial_credit_enabled === true;

      if (enabled) {
        await repo.createCreditJob({ parent: job, correctionKey: `refund:${refund.id}`, amountCents: amount, reason: 'refund' });
        credited += amount;
        handled.push(refund.id);
      } else {
        needed.push(`Refund of ${formatEuros(amount)} after issue: credit note required`);
      }
    }

    if (voided) {
      const remaining = gross - credited;
      const what = deleted ? 'deleted' : 'voided';
      if (remaining > 0 && settings.credit_notes_enabled === true) {
        await repo.createCreditJob({ parent: job, correctionKey: 'void', amountCents: remaining, reason: what });
      } else if (remaining > 0) {
        needed.push(`Invoice ${what} in Storeganise after issue: credit note required`);
      }
    }

    if (handled.length !== (job.handled_refunds || []).length) patch.handled_refunds = handled;
    const creditRequired = needed.join('; ') || null;
    if (creditRequired !== job.credit_required) patch.credit_required = creditRequired;
  }

  if (!Object.keys(patch).length) return job;
  return repo.updateJob(job.id, { ...patch, writeback_pending: true });
}

/**
 * A document Impact accepted without a MARK (status PENDING: Impact forwards it to
 * AADE when AADE is reachable). Look it up until the MARK appears.
 */
async function followUpMark(job, ctx) {
  const minutes = Number(ctx.cfg.settings.mark_followup_minutes) || 15;
  const found = await ctx.impact.findDocument({ series: job.series_code, number: job.number, dateIssued: job.date_issued });

  if (found.ok && found.document?.mark) {
    return repo.updateJob(job.id, {
      mark: found.document.mark,
      uid: found.document.uid || job.uid,
      auth_code: found.document.authCode || job.auth_code,
      qr_url: found.document.url || job.qr_url,
      impact_status: 'SUBMITTED',
      status_reason: 'MARK received after Impact forwarded the document to AADE',
      writeback_pending: true,
    });
  }

  const hours = (Date.now() - new Date(job.sent_at).getTime()) / 3600000;
  return repo.updateJob(job.id, {
    next_attempt_at: new Date(Date.now() + minutes * 60000),
    ...(hours > 24 && { last_error: `MARK still missing ${Math.floor(hours)}h after Impact accepted the document`, writeback_pending: true }),
  });
}

async function loadOwner(raw, sg) {
  const owner = typeof raw.owner === 'object' && raw.owner ? raw.owner : null;
  if (owner && owner.customFields) return owner;
  const ownerId = owner?.id || raw.ownerId;
  if (!ownerId) return owner;
  return sg.getUser(ownerId);
}

async function finish(job, ctx, customFields = null) {
  if (!job.writeback_pending) return { job };
  const updated = await writeBack(job, { sg: ctx.sg, existingCustomFields: customFields });
  return { job: updated, parkFor: updated.parkFor || null };
}
