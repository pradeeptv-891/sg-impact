import { audit } from './audit.js';
import { getSecret } from './secrets.js';
import { loadConfig } from './settings.js';

/**
 * Storeganise API client.
 *
 * Unlike the boilerplate, the base URL comes from the `sg_api_url` setting rather
 * than the webhook body: the worker, poll and reconciliation run outside any
 * webhook. The webhook's `apiUrl` is still checked against it in main.js.
 *
 * Requests go out one at a time, per Storeganise's API best practices (FRD 5.6).
 */
let chain = Promise.resolve();

function serial(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

export class StoreganiseError extends Error {
  constructor(message, { status, permanent }) {
    super(message);
    this.status = status;
    // 4xx from Storeganise will not fix itself on a retry
    this.permanent = permanent;
  }
}

export default function storeganiseApi({ apiUrl, apiKey, timeoutMs } = {}) {
  async function call(path, { method = 'GET', body } = {}) {
    const { settings } = await loadConfig();
    const base = apiUrl || settings.sg_api_url;
    if (!base) throw new StoreganiseError('Setting sg_api_url is not configured', { permanent: true });

    const key = apiKey || await getSecret('sg_api_key');
    const url = `${base.replace(/\/$/, '')}${path}`;

    return serial(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || settings.sg_timeout_ms || 20000);

      let res;
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
        throw new StoreganiseError(`Storeganise unreachable: ${err.message}`, { permanent: false });
      } finally {
        clearTimeout(timer);
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new StoreganiseError(data.error?.message || `${method} ${path} failed with ${res.status}`, {
          status: res.status,
          permanent: res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status),
        });
      }

      return data;
    });
  }

  return {
    get: path => call(path),
    post: (path, body) => call(path, { method: 'POST', body }),
    put: (path, body) => call(path, { method: 'PUT', body }),

    /** Full invoice with its customer and payments. Returns null if it was deleted. */
    async getInvoice(invoiceId) {
      try {
        return await call(`/v1/admin/invoices/${encodeURIComponent(invoiceId)}?include=owner,payments,customFields`);
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
        const invoice = await this.getInvoice(invoiceId);
        if (!invoice) return { skipped: 'invoice deleted' };
        current = invoice.customFields || {};
      }

      const body = { customFields: { ...current, ...fields } };
      const path = `/v1/admin/invoices/${encodeURIComponent(invoiceId)}`;
      const started = Date.now();

      try {
        const result = await call(path, { method: 'PUT', body });
        await audit({
          kind: 'storeganise', jobId, sgInvoiceId: invoiceId, method: 'PUT', url: path,
          statusCode: 200, durationMs: Date.now() - started, request: fields,
        });
        return result;
      } catch (err) {
        await audit({
          kind: 'storeganise', jobId, sgInvoiceId: invoiceId, method: 'PUT', url: path,
          statusCode: err.status || null, durationMs: Date.now() - started, request: fields, error: err.message,
        });
        throw err;
      }
    },
  };
}
