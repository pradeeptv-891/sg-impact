import crypto from 'crypto';

import config from './config.js';
import { audit } from './src/audit.js';
import invoiceEvent from './src/events/invoice-events.js';
import { nudgeWorker } from './src/jobs/scheduler.js';
import { getSecret } from './src/secrets.js';
import { loadConfig } from './src/settings.js';
import storeganiseApi from './src/storeganise-api.js';

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
};

// The Storeganise client used to read an invoice back; tests swap in a fake.
let sg = null;

export function setStoreganiseClient(client) {
  sg = client;
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
 * Storeganise posts:
 *   { id, businessCode, apiUrl, addonId, created, type, data }
 *
 * The status code we return decides what Storeganise does next:
 *   2xx       accepted, done
 *   400 / 404 permanent failure, Storeganise does NOT retry
 *   other 4xx/5xx  Storeganise retries with backoff, then raises a failure task
 *
 * This handler records the event and, for an invoice not tracked yet, reads it back
 * once to check it is fully paid; nothing is sent to Impact here, so it answers
 * well inside 30 seconds. A 500 is returned only if the event could not be recorded
 * (database or Storeganise unreachable), so Storeganise retries it; the safety-net
 * poll covers anything still missed.
 */
export default async function handleWebhook(req, res) {
  const signature = req.headers['sg-signature'];

  let secret;
  try {
    secret = await getSecret('sg_webhook_secret');
  } catch (err) {
    console.error('Webhook secret unavailable', err.message);
    return res.status(500).json({ message: 'Temporarily unavailable' });
  }

  if (!isValidSignature(req.rawBody, signature, secret)) {
    await audit({ kind: 'webhook', method: 'POST', url: '/webhook', statusCode: 400, error: 'Invalid signature' });
    return res.status(400).json({ message: 'Invalid signature' });
  }

  const { id, type: event, data, businessCode, apiUrl } = req.body || {};

  if (config.debug) console.log('Webhook received', { id, event, data });

  try {
    // One operator only (FRD 1.2): refuse webhooks for any other business. Add-on
    // webhooks carry businessCode/apiUrl; plain webhooks (Main Settings → Developer →
    // Webhooks) do not, and are already tied to this business by the shared secret.
    const { settings } = await loadConfig();
    const wrongBusiness = settings.sg_business_code && businessCode && businessCode !== settings.sg_business_code;
    const wrongApi = settings.sg_api_url && apiUrl && apiUrl.replace(/\/$/, '') !== settings.sg_api_url.replace(/\/$/, '');
    if (wrongBusiness || wrongApi) {
      await audit({ kind: 'webhook', method: event, request: req.body, statusCode: 400, error: 'Unexpected business' });
      return res.status(400).json({ message: 'Unexpected business' });
    }

    const handler = handlers[event];

    // Not an event we care about. Accept it so Storeganise does not retry.
    if (!handler) {
      await audit({ kind: 'webhook', method: event, request: req.body, statusCode: 200, response: { ignored: event } });
      return res.status(200).json({ ignored: event });
    }

    sg ||= storeganiseApi();
    const result = await handler({ event, data, webhookId: id, sg });

    await audit({
      kind: 'webhook', method: event, sgInvoiceId: data?.invoiceId || null, jobId: result.jobId || null,
      request: req.body, statusCode: 200, response: result,
    });

    if (result.queued) nudgeWorker();

    return res.status(200).json(result);
  } catch (err) {
    console.error('Webhook not recorded', { event, data, message: err.message });
    await audit({ kind: 'webhook', method: event, request: req.body, statusCode: 500, error: err.message });
    // Not permanent: let Storeganise retry
    return res.status(500).json({ message: 'Could not record event' });
  }
}
