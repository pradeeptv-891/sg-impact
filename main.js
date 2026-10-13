import crypto from 'crypto';

import config from './config.js';
import { audit } from './src/audit.js';
import { companyByCode, storeganiseFor } from './src/companies.js';
import invoiceEvent from './src/events/invoice-events.js';
import userEvent from './src/events/user-events.js';
import { nudgeWorker } from './src/jobs/scheduler.js';
import { getCompanySecrets } from './src/secrets.js';
import { loadConfig } from './src/settings.js';

/**
 * Which Storeganise events this add-on reacts to.
 * Add a line here and tick the same event on the webhook in the Add-on config.
 *
 * invoice.created is deliberately absent (FR-CAP-01): an unpaid invoice is a pro
 * forma and nothing happens in the add-on until it is fully paid. If it arrives it
 * is acknowledged and ignored like any other unhandled event.
 */
const handlers = {
  'invoice.state.updated': invoiceEvent,
  'invoice.payments.updated': invoiceEvent,
  'invoice.deleted': invoiceEvent,
  // Customer tax data fixed: re-check that customer's held invoices (FR-CUS-02)
  'user.updated': userEvent,
};

// Storeganise client per company; tests swap in a fake (one client or a factory).
let sgFor = storeganiseFor;

export function setStoreganiseClient(clientOrFactory) {
  sgFor = typeof clientOrFactory === 'function' ? clientOrFactory : () => clientOrFactory;
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

export function isValidSignature(rawBody, signature, secret) {
  if (!signature || !rawBody?.length || !secret) return false;

  const expected = Buffer.from(sign(rawBody, secret));
  const received = Buffer.from(signature);

  // timingSafeEqual throws on a length mismatch, so check length first
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/**
 * POST /sg-webhook/:code, one URL per company (scope §10.2); `code` is
 * einvoice.companies.code. Storeganise posts:
 *   { id, businessCode, apiUrl, addonId, created, type, data }
 *
 * Storeganise expects a 200 within 30 seconds. Any other response, or no answer
 * in time, is retried 2 more times and then reported to the webhook's alert
 * receivers (help.storeganise.com, articles 19 and 475). So:
 *   200       accepted (including events that are ignored on purpose)
 *   400 / 404 refused (bad signature, other business, unknown company): a retry
 *             gets the same answer, and the alert tells the operator
 *   500       not recorded (database or Storeganise unavailable); the retries
 *             and the safety-net poll pick it up
 *
 * Unknown or inactive company → 404. The signature is checked with that company's
 * own secret, so a webhook signed for company B is refused on company A's URL.
 *
 * This handler records the event and, for an invoice not tracked yet, reads it back
 * once to check it is fully paid; nothing is sent to Impact here. That read is
 * given WEBHOOK_SG_BUDGET_MS, queue wait and retries included, so the answer
 * always comes inside the 30 seconds. A 500 is returned only if the event could not be recorded
 * (database or Storeganise unreachable), so Storeganise retries it; the safety-net
 * poll covers anything still missed.
 */
// Leaves room under Storeganise's 30s for the database work around the read
const WEBHOOK_SG_BUDGET_MS = 20000;

export default async function handleWebhook(req, res) {
  const deadline = Date.now() + WEBHOOK_SG_BUDGET_MS;
  const signature = req.headers['sg-signature'];
  const code = req.params?.code;
  const url = `/sg-webhook/${code}`;

  let cfg;
  let company;
  let secret;
  try {
    cfg = await loadConfig();
    company = companyByCode(cfg, code);
    if (company?.active) secret = (await getCompanySecrets(company)).sgWebhookSecret;
  } catch (err) {
    console.error('Webhook config unavailable', err.message);
    return res.status(500).json({ message: 'Temporarily unavailable' });
  }

  if (!company?.active) {
    await audit({ kind: 'webhook', method: 'POST', url, statusCode: 404, error: 'Unknown or inactive company' });
    return res.status(404).json({ message: 'Unknown company' });
  }

  if (!secret) {
    console.error(`Webhook secret sg_${company.code}_webhook_secret is not configured in Vault`);
    return res.status(500).json({ message: 'Temporarily unavailable' });
  }

  if (!isValidSignature(req.rawBody, signature, secret)) {
    await audit({ kind: 'webhook', companyId: company.id, method: 'POST', url, statusCode: 400, error: 'Invalid signature' });
    return res.status(400).json({ message: 'Invalid signature' });
  }

  const { id, type: event, data, businessCode, apiUrl } = req.body || {};
  const logged = { kind: 'webhook', companyId: company.id, method: event, url, request: req.body };

  if (config.debug) console.log('Webhook received', { company: company.code, id, event, data });

  try {
    // Refuse webhooks for a business other than this company's. Add-on webhooks
    // carry businessCode/apiUrl; plain webhooks (Main Settings → Developer →
    // Webhooks) do not, and are already tied to the company by its secret.
    const wrongBusiness = company.sg_business_code && businessCode && businessCode !== company.sg_business_code;
    const wrongApi = company.sg_api_url && apiUrl && apiUrl.replace(/\/$/, '') !== company.sg_api_url.replace(/\/$/, '');
    if (wrongBusiness || wrongApi) {
      await audit({ ...logged, statusCode: 400, error: 'Unexpected business' });
      return res.status(400).json({ message: 'Unexpected business' });
    }

    const handler = handlers[event];

    // Not an event we care about. Accept it so Storeganise does not retry.
    if (!handler) {
      await audit({ ...logged, statusCode: 200, response: { ignored: event } });
      return res.status(200).json({ ignored: event });
    }

    const result = await handler({ event, data, webhookId: id, sg: sgFor(company), company, cfg, deadline });

    await audit({
      ...logged, companyId: result.companyId || company.id, sgInvoiceId: data?.invoiceId || null,
      jobId: result.jobId || null, statusCode: 200, response: result,
    });

    if (result.queued) nudgeWorker();

    return res.status(200).json(result);
  } catch (err) {
    console.error('Webhook not recorded', { company: company.code, event, data, message: err.message });
    await audit({ ...logged, statusCode: 500, error: err.message });
    // Not permanent: let Storeganise retry
    return res.status(500).json({ message: 'Could not record event' });
  }
}
