import * as repo from './repo.js';

/**
 * FR-TX-05: mirrors a job onto the Storeganise invoice's ei_* custom fields so
 * staff see the e-invoicing result on the invoice itself (FRD 5.7).
 *
 * Only changes are written. A failed write sets writeback_pending and the worker
 * tries again; it never affects the job's transmission status.
 */

const STATUS_LABELS = {
  waiting: 'pending',
  pending: 'pending',
  sending: 'sending',
  retry: 'retry',
  sent: 'sent',
  held: 'held',
  failed_data: 'failed – data',
  failed: 'failed',
  skipped: 'skipped',
  credited: 'credited',
};

export function fieldsFor(job, creditJobs = []) {
  const creditMarks = creditJobs.filter(c => c.mark).map(c => c.mark);
  const error = job.last_error
    || job.credit_required
    || (job.status === 'sent' && !job.mark ? 'Accepted by Impact; MARK pending from AADE' : '')
    || (job.changed_after_issue ? 'Changed after issue: this invoice differs from the e-invoice sent. Issue a credit note and re-invoice.' : '');

  return {
    ei_status: STATUS_LABELS[job.status] || job.status,
    ei_doctype: job.invoice_type_code || '',
    ei_series: job.series_code || '',
    ei_number: job.number ? String(job.number) : '',
    ei_mark: job.mark || '',
    ei_uid: job.uid || '',
    ei_auth_code: job.auth_code || '',
    ei_qr_url: job.qr_url || '',
    ei_error: error || '',
    ei_sent_at: job.sent_at ? new Date(job.sent_at).toISOString() : '',
    ei_credit_mark: creditMarks.join(', '),
  };
}

/**
 * Writes the job's fields if they changed. `existingCustomFields` avoids an extra
 * GET when the caller has just read the invoice.
 */
export async function writeBack(job, { sg, existingCustomFields = null } = {}) {
  if (job.kind !== 'invoice') return job;

  // Nothing worth telling staff yet (draft / not yet due), and nothing written before
  if (['new', 'waiting'].includes(job.status) && !job.written_back) {
    return job.writeback_pending ? repo.updateJob(job.id, { writeback_pending: false }) : job;
  }

  const creditJobs = await repo.creditJobsFor(job.id);
  const fields = fieldsFor(job, creditJobs);
  const previous = job.written_back || {};
  const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => previous[k] !== v));

  if (!Object.keys(changed).length) {
    return job.writeback_pending ? repo.updateJob(job.id, { writeback_pending: false }) : job;
  }

  try {
    const result = await sg.updateInvoiceCustomFields(job.sg_invoice_id, changed, {
      existing: existingCustomFields,
      jobId: job.id,
    });
    // A deleted invoice has nowhere to write to; nothing to retry
    return repo.updateJob(job.id, {
      written_back: result?.skipped ? previous : fields,
      writeback_pending: false,
    });
  } catch (err) {
    console.error('Write-back failed', { job: job.id, invoice: job.sg_invoice_id, message: err.message });
    // Retry on a later run, not in a hot loop
    const updated = await repo.updateJob(job.id, { writeback_pending: true });
    updated.parkFor = 300;
    return updated;
  }
}
