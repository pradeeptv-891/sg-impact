import { audit } from './audit.js';
import { getCompanySecrets } from './secrets.js';
import { loadConfig } from './settings.js';

/**
 * Storeganise API client for one company (scope §8.4: no global credentials).
 *
 * Unlike the boilerplate, the base URL comes from the company's `sg_api_url`
 * rather than the webhook body: the worker, poll and reconciliation run outside any
 * webhook. The webhook's `apiUrl` is still checked against it in main.js.
 *
 * Follows Storeganise's API best practices (help.storeganise.com, article 297):
 * - Requests to one Storeganise account go out one at a time ("make requests in
 *   series"). The queue is per account, not per client, so companies sharing an
 *   account in site mode still share one queue.
 * - `include` only on single-invoice reads, never on list endpoints.
 * - Syncing uses `updatedAfter` with a UTC ISO timestamp.
 * And the add-on technical reference (article 475): network failures and 408 /
 * 429 / 5xx are retried with backoff (honouring Retry-After), a bounded number of
 * times; other 4xx are permanent. GET and PUT are the only methods retried, since
 * both are safe to repeat here (the PUT sends the full custom-field set).
 *
 * Use companies.storeganiseFor() so a company always gets the same client.
 */

export class StoreganiseError extends Error {
  constructor(message, { status, permanent }) {
    super(message);
    this.status = status;
    // 4xx from Storeganise will not fix itself on a retry
    this.permanent = permanent;
  }
}

// One serial queue per Storeganise account (base URL)
const queues = new Map();

function serial(account, fn) {
  const run = (queues.get(account) || Promise.resolve()).then(fn, fn);
  queues.set(account, run.catch(() => {}));
  return run;
}

const RETRYABLE_METHODS = new Set(['GET', 'PUT']);
const MAX_RETRY_DELAY_MS = 10000;

function isTransient(status) {
  return status === 408 || status === 429 || status >= 500;
}

/** Retry-After in seconds or as an HTTP date; null if absent or unreadable. */
function retryAfterMs(res) {
  const value = res.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default function storeganiseApi({ company = null, apiUrl, apiKey, timeoutMs } = {}) {
  const who = company ? `company ${company.code}` : 'this client';

  /**
   * `deadline` (epoch ms) bounds the whole call, queue wait and retries included,
   * e.g. so a webhook answers inside Storeganise's 30 seconds.
   */
  async function call(path, { method = 'GET', body, deadline = null } = {}) {
    const { settings } = await loadConfig();
    const base = (apiUrl || company?.sg_api_url || '').replace(/\/$/, '');
    if (!base) throw new StoreganiseError(`sg_api_url is not configured for ${who}`, { permanent: true });

    const key = apiKey || (company && (await getCompanySecrets(company)).sgApiKey);
    if (!key) throw new StoreganiseError(`Secret sg_${company?.code}_api_key is not configured in Vault`, { permanent: true });
    const url = `${base}${path}`;
    const timeout = timeoutMs || Number(settings.sg_timeout_ms) || 20000;
    const retries = RETRYABLE_METHODS.has(method) ? Number(settings.sg_retry_attempts ?? 2) : 0;

    const outOfTime = () => new StoreganiseError(`${method} ${path}: no time left to call Storeganise`, { permanent: false });

    return serial(base, async () => {
      for (let attempt = 0; ; attempt++) {
        const left = deadline ? deadline - Date.now() : Infinity;
        if (left <= 0) throw outOfTime();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(timeout, left));

        let res = null;
        let error;
        try {
          res = await fetch(url, {
            method,
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              Authorization: `ApiKey ${key}`,
            },
            body: body && JSON.stringify(body),
          });
        } catch (err) {
          error = new StoreganiseError(`Storeganise unreachable: ${err.message}`, { permanent: false });
        } finally {
          clearTimeout(timer);
        }

        if (res) {
          const data = await res.json().catch(() => ({}));
          if (res.ok) return data;
          error = new StoreganiseError(data.error?.message || `${method} ${path} failed with ${res.status}`, {
            status: res.status,
            permanent: !isTransient(res.status),
          });
        }

        if (error.permanent || attempt >= retries) throw error;

        const wait = Math.min(res ? retryAfterMs(res) ?? 1000 * 3 ** attempt : 1000 * 3 ** attempt, MAX_RETRY_DELAY_MS);
        if (deadline && Date.now() + wait >= deadline) throw error;
        await sleep(wait);
      }
    });
  }

  return {
    get: path => call(path),
    post: (path, body) => call(path, { method: 'POST', body }),
    put: (path, body) => call(path, { method: 'PUT', body }),

    /**
     * Full invoice with its customer and payments (a single-entity read, where
     * Storeganise recommends `include`). Returns null if it was deleted.
     */
    async getInvoice(invoiceId, { deadline } = {}) {
      try {
        return await call(`/v1/admin/invoices/${encodeURIComponent(invoiceId)}?include=owner,payments,customFields`, { deadline });
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },

    async getUser(userId) {
      return call(`/v1/admin/users/${encodeURIComponent(userId)}?include=customFields`);
    },

    /** One page of invoices changed since `updatedAfter` (FR-CAP-04). */
    async listInvoices({ updatedAfter, limit = 100, offset = 0 }) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (updatedAfter) params.set('updatedAfter', updatedAfter);
      const data = await call(`/v1/admin/invoices?${params}`);
      return Array.isArray(data) ? data : data.items || data.results || [];
    },

    /**
     * Writes the ei_* custom fields (FR-TX-05). Existing custom fields are merged
     * in so values owned by other integrations are never wiped.
     */
    async updateInvoiceCustomFields(invoiceId, fields, { existing, jobId } = {}) {
      let current = existing;
      if (!current) {
        // Only the custom fields are needed here: include nothing else
        let invoice;
        try {
          invoice = await call(`/v1/admin/invoices/${encodeURIComponent(invoiceId)}?include=customFields`);
        } catch (err) {
          if (err.status === 404) return { skipped: 'invoice deleted' };
          throw err;
        }
        current = invoice.customFields || {};
      }

      const body = { customFields: { ...current, ...fields } };
      const path = `/v1/admin/invoices/${encodeURIComponent(invoiceId)}`;
      const started = Date.now();

      try {
        const result = await call(path, { method: 'PUT', body });
        await audit({
          kind: 'storeganise', companyId: company?.id, jobId, sgInvoiceId: invoiceId, method: 'PUT', url: path,
          statusCode: 200, durationMs: Date.now() - started, request: fields,
        });
        return result;
      } catch (err) {
        await audit({
          kind: 'storeganise', companyId: company?.id, jobId, sgInvoiceId: invoiceId, method: 'PUT', url: path,
          statusCode: err.status || null, durationMs: Date.now() - started, request: fields, error: err.message,
        });
        throw err;
      }
    },
  };
}
