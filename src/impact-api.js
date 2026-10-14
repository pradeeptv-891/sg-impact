import { audit } from './audit.js';
import { getSecret } from './secrets.js';
import { forCompany, loadConfig } from './settings.js';

/**
 * IMPACT INVOICING client (FRD 5.1 – 5.3), per developers.s1ecos.com.
 *
 * One client per company (scope §10): each company issues under its own ΑΦΜ with
 * its own API key, from Vault as impact_<code>_uat_api_key /
 * impact_<code>_production_api_key. Environment, hosts, paths and auth mode are
 * shared settings.
 *
 * Every call returns an `outcome` instead of throwing, so the caller can apply the
 * FRD's response policy:
 *   success    201 / 2xx
 *   duplicate  409, the document is already at AADE: recover its identifiers
 *   invalid    400 and other 4xx, a retry of the same payload will never succeed
 *   transient  408, 429, 5xx, network errors, timeouts: retry with backoff
 * 401 is handled here: the token is refreshed and the call retried once (FR-TX-01).
 *
 * Auth modes, all driven by the one API key Impact issues per company:
 *   apikey  APIKey: <key> header on every call
 *   jwt     POST /Authentication/login { vat, key } → accessToken (15 min)
 *   oauth2  POST /oauth/token client_credentials, client_id = issuer TIN (EL…),
 *           client_secret = API key → access_token (expires_in 900)
 */

// Access tokens per company and environment: `${companyId}|${env}` → { value, expiresAt }
const tokens = new Map();

export function apiKeySecretName(company, env) {
  return `impact_${company.code}_${env}_api_key`;
}

async function environment(company) {
  const cfg = forCompany(await loadConfig(), company);
  const { settings, issuer } = cfg;
  const env = settings.impact_env === 'production' ? 'production' : 'uat';
  return {
    env,
    company,
    settings,
    issuer,
    secretName: apiKeySecretName(company, env),
    baseUrl: settings[`impact_base_url_${env}`],
    portalUrl: settings[`impact_portal_url_${env}`],
  };
}

async function fetchToken({ settings, issuer, baseUrl, secretName }) {
  const mode = settings.impact_auth_mode;
  const key = await getSecret(secretName);
  const tin = `EL${issuer?.afm || ''}`;

  let res;
  if (mode === 'oauth2') {
    res = await fetch(settings.impact_token_url || `${baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: tin, client_secret: key }),
    });
  } else {
    res = await fetch(settings.impact_token_url || `${baseUrl}/Authentication/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vat: tin, key }),
    });
  }

  const body = await res.json().catch(() => ({}));
  const value = body.access_token || body.accessToken || body.token;
  if (!res.ok || !value) throw new Error(`Impact login failed with ${res.status}: ${body.error_description || body.message || ''}`.trim());

  // Access tokens last 15 minutes; a new login is simpler than the refresh flow and
  // costs one extra call every quarter of an hour at most.
  const ttlSeconds = Number(body.expires_in || body.expiresIn) || jwtTtl(value) || 900;
  return { value, expiresAt: Date.now() + Math.max(ttlSeconds - 60, 30) * 1000 };
}

function jwtTtl(value) {
  try {
    const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString());
    return claims.exp ? claims.exp - Math.floor(Date.now() / 1000) : null;
  } catch {
    return null;
  }
}

async function authHeaders(ctx, { forceRefresh = false } = {}) {
  const { env, settings, company } = ctx;
  const mode = settings.impact_auth_mode || 'apikey';

  if (mode === 'apikey') {
    return { [settings.impact_apikey_header || 'APIKey']: await getSecret(ctx.secretName) };
  }

  const key = `${company.id}|${env}`;
  let token = tokens.get(key);
  if (forceRefresh || !token || Date.now() >= token.expiresAt) {
    token = await fetchToken(ctx);
    tokens.set(key, token);
  }
  return { Authorization: `Bearer ${token.value}` };
}

async function request(method, url, { body, jobId, sgInvoiceId, ctx, auditBody = true } = {}) {
  const timeoutMs = ctx.settings.impact_timeout_ms || 30000;

  async function attempt(forceRefresh) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();

    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...await authHeaders(ctx, { forceRefresh }),
        },
        body: body && JSON.stringify(body),
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { raw: text.slice(0, 5000) };
      }
      return { status: res.status, body: parsed, headers: res.headers, durationMs: Date.now() - started };
    } catch (err) {
      return { status: null, body: null, error: err.name === 'AbortError' ? 'timeout' : err.message, durationMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  let result = await attempt(false);
  if (result.status === 401) result = await attempt(true);

  await audit({
    kind: 'impact', companyId: ctx.company.id, jobId, sgInvoiceId, method, url: url.replace(/\?.*$/, ''),
    statusCode: result.status, durationMs: result.durationMs,
    request: auditBody ? body : null, response: result.body, error: result.error || null,
  });

  return { ...result, outcome: classify(result.status) };
}

/**
 * HTTP status → outcome. A 201 can still carry status INVALID (sign policy LOOSE),
 * which the caller treats as invalid; see applyResult.
 */
export function classify(status) {
  if (status === null || status === undefined) return 'transient';
  if (status >= 200 && status < 300) return 'success';
  if (status === 409) return 'duplicate';
  if ([401, 408, 425, 429].includes(status) || status >= 500) return 'transient';
  return 'invalid';
}

/**
 * The Impact client for one company. Everything it sends carries that company's
 * API key and is filed under its ΑΦΜ.
 */
export function impactFor(company) {
  /** POST /invoice/json (FR-TX-02). */
  async function sendDocument(payload, { jobId, sgInvoiceId } = {}) {
    const ctx = await environment(company);
    return request('POST', `${ctx.baseUrl}${ctx.settings.impact_send_path}`, { body: payload, jobId, sgInvoiceId, ctx });
  }

  /**
   * GET getdocuments: one page (max 100) of the company's documents, used for MARK
   * recovery and reconciliation. Served from the portal host. Dates are YYYYMMDD;
   * the NextPage response header is present while more pages exist.
   */
  async function getDocuments({ from, to, lastUpdate, page = 1 } = {}) {
    const ctx = await environment(company);
    const vat = `EL${ctx.issuer?.afm || ''}`;
    const path = ctx.settings.impact_getdocuments_path
      .replace('{vat}', encodeURIComponent(vat))
      .replace('{page}', String(page));
    const params = new URLSearchParams();
    if (from) params.set('From', from);
    if (to) params.set('To', to);
    if (lastUpdate) params.set('LastUpdate', lastUpdate);

    const result = await request('GET', `${ctx.portalUrl}${path}${params.size ? `?${params}` : ''}`, { ctx });
    if (result.outcome !== 'success') {
      return { ok: false, status: result.status, error: result.error, documents: [] };
    }

    const body = result.body;
    const documents = Array.isArray(body) ? body : body?.documents || body?.Documents || body?.items || [];
    const nextPage = result.headers?.get?.('NextPage') || null;
    return { ok: true, documents: documents.map(normalizeDocument), nextPage };
  }

  /** Walks every page of getdocuments. */
  async function getAllDocuments(filters) {
    const all = [];
    for (let page = 1; page <= 500; page++) {
      const result = await getDocuments({ ...filters, page });
      if (!result.ok) return { ok: false, status: result.status, error: result.error, documents: all };
      all.push(...result.documents);
      if (!result.nextPage || result.documents.length === 0) break;
    }
    return { ok: true, documents: all };
  }

  /** Finds a document by series/number around its issue date (MARK recovery). */
  async function findDocument({ series, number, dateIssued }) {
    const day = new Date(dateIssued || Date.now());
    const from = yyyymmdd(new Date(day.getTime() - 86400000));
    const to = yyyymmdd(new Date(Math.max(day.getTime() + 86400000, Date.now())));
    const result = await getAllDocuments({ from, to });
    if (!result.ok) return { ok: false, error: result.error || `getdocuments failed with ${result.status}` };

    const match = result.documents.find(doc => doc.series === series && Number(doc.number) === Number(number));
    return { ok: true, document: match || null };
  }

  /** The company's Impact API key (also the OAuth client secret and offline-QR salt). */
  async function apiKey() {
    return getSecret((await environment(company)).secretName);
  }

  /**
   * Why the company cannot send yet, or null when it can: its issuer and its API
   * key for the current environment must both be configured.
   */
  async function notReady() {
    const ctx = await environment(company);
    if (!ctx.issuer) return `Issuer not configured for company ${company.code} (einvoice.issuer)`;
    const key = await getSecret(ctx.secretName, { required: false });
    if (!key) return `Impact API key not configured for company ${company.code} (Vault secret ${ctx.secretName})`;
    return null;
  }

  return {
    company,
    sendDocument,
    getDocuments,
    getAllDocuments,
    findDocument,
    apiKey,
    notReady,
    portalUrl: async () => (await environment(company)).portalUrl,
  };
}

/**
 * Pulls MARK / UID / authentication code / QR link out of Impact's SignatureResponse
 * (returned on 201 and on 409) or a getdocuments entry.
 */
export function extractIdentifiers(body) {
  if (!body || typeof body !== 'object') return {};
  const source = body.data || body.result || body.document || body;
  const pick = (...names) => {
    for (const name of names) {
      for (const key of Object.keys(source)) {
        if (key.toLowerCase() === name.toLowerCase() && source[key] !== null && source[key] !== '') return String(source[key]);
      }
    }
    return null;
  };
  return {
    // mark is an int64 in Impact's schema; kept as a string here (15+ digits)
    mark: pick('mark'),
    uid: pick('uid'),
    authCode: pick('authenticationCode'),
    // "QR code: received as a response from REST API call 'url'" (Impact docs)
    url: pick('url', 'qrCodeString'),
    status: pick('status'),
    series: pick('series'),
    number: pick('number'),
  };
}

function normalizeDocument(doc) {
  const ids = extractIdentifiers(doc);
  return {
    ...ids,
    series: ids.series,
    number: ids.number,
    dateIssued: doc.dateIssued || doc.DateIssued || null,
    totalAmount: numberOrNull(doc.totalAmount ?? doc.TotalAmount),
    totalVatAmount: numberOrNull(doc.totalVatAmount ?? doc.TotalVatAmount),
    invoiceType: doc.invoiceType || doc.InvoiceType || null,
    counterPartyVat: doc.counterPartyVAT || doc.counterPartyVat || null,
    dateUpdated: doc.dateUpdated || null,
    raw: doc,
  };
}

function numberOrNull(value) {
  return value === undefined || value === null || value === '' ? null : Number(value);
}

export function yyyymmdd(date) {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

/** For tests. */
export function resetTokenCache() {
  tokens.clear();
}
