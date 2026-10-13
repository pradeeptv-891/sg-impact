import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import * as impact from '../src/impact-api.js';
import { clearSecretCache } from '../src/secrets.js';
import { loadConfig } from '../src/settings.js';
import storeganiseApi from '../src/storeganise-api.js';
import { freshDb, setSetting } from './helpers.js';

let pg;
let calls;
const realFetch = globalThis.fetch;

/** Queue of responses for the mocked fetch; each call is recorded. */
function mockFetch(responses) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body: init.body });
    const next = responses.shift() || { status: 200, body: {} };
    if (next.throw) throw new Error(next.throw);
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers || {},
    });
  };
}

beforeEach(async () => {
  pg = await freshDb();
  // Stand-in for the Vault-backed function from the Supabase-only migration
  await pg.exec(`
    create function einvoice.get_secret(p_name text) returns text language sql as $$
      select case p_name
        when 'impact_uat_api_key' then 'uat-key'
        when 'sg_propco_api_key' then 'sg-key'
      end
    $$;
  `);
  clearSecretCache();
  impact.resetTokenCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('Impact: APIKey header, UAT URL, audit log without credentials', async () => {
  mockFetch([{ status: 201, body: { mark: '400001', uid: 'U1', authenticationCode: 'A1', url: 'https://q' } }]);

  const result = await impact.sendDocument({ series: 'TPY', number: '1' }, { jobId: null, sgInvoiceId: 'inv-1' });

  assert.equal(result.outcome, 'success');
  assert.equal(calls[0].url, 'https://einvoiceapiuat.impact.gr/invoice/json');
  assert.equal(calls[0].headers.APIKey, 'uat-key');
  assert.deepEqual(impact.extractIdentifiers(result.body), {
    mark: '400001', uid: 'U1', authCode: 'A1', url: 'https://q', status: null, series: null, number: null,
  });

  const { rows } = await pg.query(`select * from einvoice.audit_log where kind = 'impact'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status_code, 201);
  assert.ok(!JSON.stringify(rows[0]).includes('uat-key'), 'API key never logged');
});

test('Impact: production environment switches base URL without code changes (FR-CFG-01)', async () => {
  await setSetting(pg, 'impact_env', 'production');
  await pg.exec(`create or replace function einvoice.get_secret(p_name text) returns text language sql as $$ select 'prod-key' $$`);
  clearSecretCache();
  mockFetch([{ status: 201, body: {} }]);

  await impact.sendDocument({});
  assert.equal(calls[0].url, 'https://einvoiceapi.impact.gr/invoice/json');
  assert.equal(calls[0].headers.APIKey, 'prod-key');
});

test('Impact: OAuth2 client credentials (client_id = issuer TIN, secret = API key), refreshed on 401 (FR-TX-01)', async () => {
  await setSetting(pg, 'impact_auth_mode', 'oauth2');
  mockFetch([
    { status: 200, body: { access_token: 'T1', token_type: 'Bearer', expires_in: 900 } },
    { status: 201, body: {} },
    { status: 401, body: {} },
    { status: 200, body: { access_token: 'T2', token_type: 'Bearer', expires_in: 900 } },
    { status: 201, body: {} },
  ]);

  assert.equal((await impact.sendDocument({})).outcome, 'success');
  assert.equal((await impact.sendDocument({})).outcome, 'success');

  assert.deepEqual(calls.map(c => c.url), [
    'https://einvoiceapiuat.impact.gr/oauth/token',
    'https://einvoiceapiuat.impact.gr/invoice/json',
    'https://einvoiceapiuat.impact.gr/invoice/json',
    'https://einvoiceapiuat.impact.gr/oauth/token',
    'https://einvoiceapiuat.impact.gr/invoice/json',
  ]);
  assert.equal(String(calls[0].body), 'grant_type=client_credentials&client_id=EL999645320&client_secret=uat-key');
  assert.equal(calls[1].headers.Authorization, 'Bearer T1');
  assert.equal(calls[1].headers.APIKey, undefined);
  assert.equal(calls[4].headers.Authorization, 'Bearer T2');
});

test('Impact: JWT login with { vat, key }; token reused until it expires', async () => {
  await setSetting(pg, 'impact_auth_mode', 'jwt');
  mockFetch([
    { status: 200, body: { accessToken: 'J1', refreshToken: { token: 'R1', expires: '2026-10-07T00:00:00Z' } } },
    { status: 201, body: {} },
    { status: 201, body: {} },
  ]);

  await impact.sendDocument({});
  await impact.sendDocument({});
  assert.equal(calls[0].url, 'https://einvoiceapiuat.impact.gr/Authentication/login');
  assert.deepEqual(JSON.parse(calls[0].body), { vat: 'EL999645320', key: 'uat-key' });
  assert.equal(calls.length, 3, 'one login for both sends');
  assert.equal(calls[2].headers.Authorization, 'Bearer J1');
});

test('Impact: SignatureResponse identifiers, numeric MARK kept exact', () => {
  const ids = impact.extractIdentifiers({
    success: true, uid: 'CB0F75384A2B39D2BB9D15962E935284EF51E4A2', mark: 400001825348483,
    authenticationCode: 'DD07A78D21AB8BFE84D68B37EBF597F8DB25DEB7', status: 'SUBMITTED', series: 'ΤΔΑ', number: '60',
    url: 'https://einvoice.s1ecos.gr/p/EL146862051/x',
  });
  assert.equal(ids.mark, '400001825348483');
  assert.equal(ids.status, 'SUBMITTED');
  assert.equal(ids.url, 'https://einvoice.s1ecos.gr/p/EL146862051/x');
});

test('Impact: network failure is transient; getdocuments pages and finds by series/number', async () => {
  mockFetch([{ throw: 'ECONNRESET' }]);
  const failed = await impact.sendDocument({});
  assert.equal(failed.outcome, 'transient');
  assert.equal(failed.error, 'ECONNRESET');

  await pg.query(`insert into einvoice.settings (key, value) values ('x', '1')`);
  mockFetch([
    { status: 200, body: [{ series: 'TPY', number: '1', mark: 'M1' }], headers: { NextPage: '2' } },
    { status: 200, body: [{ series: 'TPY', number: '0002', mark: 'M2', authenticationCode: 'A2' }] },
  ]);
  const found = await impact.findDocument({ series: 'TPY', number: 2, dateIssued: new Date() });
  assert.equal(found.document.mark, 'M2');
  assert.equal(found.document.authCode, 'A2');
  assert.match(calls[0].url, /^https:\/\/einvoiceportaluat\.impact\.gr\/api\/invoice\/getdocuments\/EL999645320\/1\/\?From=\d{8}&To=\d{8}$/);
  assert.match(calls[1].url, /\/getdocuments\/EL999645320\/2\//);
});

test('Storeganise: ApiKey auth, custom fields merged, write-back audited, 404 → null', async () => {
  const { companies } = await loadConfig({ fresh: true });
  const propco = companies.find(c => c.code === 'propco');
  const sg = storeganiseApi({ company: propco });
  mockFetch([
    { status: 200, body: { id: 'inv-1', customFields: { other_integration: 'keep' } } },
    { status: 200, body: {} },
    { status: 404, body: { error: { message: 'Not found' } } },
  ]);

  await sg.updateInvoiceCustomFields('inv-1', { ei_status: 'sent' });
  assert.equal(calls[0].headers.Authorization, 'ApiKey sg-key');
  assert.equal(calls[0].url, 'https://acme.storeganise.com/api/v1/admin/invoices/inv-1?include=customFields');
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].body), { customFields: { other_integration: 'keep', ei_status: 'sent' } });

  assert.equal(await sg.getInvoice('gone'), null);

  const { rows } = await pg.query(`select * from einvoice.audit_log where kind = 'storeganise'`);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].request, { ei_status: 'sent' });
  assert.equal(rows[0].company_id, propco.id);
});

// Storeganise add-on technical reference / API best practices (articles 475, 297)

async function propcoClient() {
  const { companies } = await loadConfig({ fresh: true });
  return storeganiseApi({ company: companies.find(c => c.code === 'propco') });
}

test('Storeganise: 429 / 5xx retried, honouring Retry-After; then gives up as transient', async () => {
  const sg = await propcoClient();
  mockFetch([
    { status: 429, body: {}, headers: { 'Retry-After': '0' } },
    { status: 503, body: {}, headers: { 'Retry-After': '0' } },
    { status: 200, body: { id: 'inv-1' } },
  ]);
  assert.deepEqual(await sg.getInvoice('inv-1'), { id: 'inv-1' });
  assert.equal(calls.length, 3);

  mockFetch([
    { status: 502, body: {}, headers: { 'Retry-After': '0' } },
    { status: 502, body: {}, headers: { 'Retry-After': '0' } },
    { status: 502, body: {}, headers: { 'Retry-After': '0' } },
    { status: 200, body: {} },
  ]);
  await assert.rejects(sg.getInvoice('inv-1'), err => err.status === 502 && err.permanent === false);
  assert.equal(calls.length, 3, 'two retries by default (sg_retry_attempts)');
});

test('Storeganise: other 4xx are permanent and not retried; POST is never retried', async () => {
  const sg = await propcoClient();
  mockFetch([{ status: 400, body: { error: { message: 'Bad request' } } }, { status: 200, body: {} }]);
  await assert.rejects(sg.getInvoice('inv-1'), err => err.permanent === true && /Bad request/.test(err.message));
  assert.equal(calls.length, 1);

  mockFetch([{ status: 503, body: {}, headers: { 'Retry-After': '0' } }, { status: 200, body: {} }]);
  await assert.rejects(sg.post('/v1/admin/something', {}), err => err.status === 503);
  assert.equal(calls.length, 1);
});

test('Storeganise: a deadline stops retries that would not fit (webhook 30s rule)', async () => {
  const sg = await propcoClient();
  mockFetch([{ status: 503, body: {}, headers: { 'Retry-After': '5' } }, { status: 200, body: {} }]);
  const started = Date.now();
  await assert.rejects(sg.getInvoice('inv-1', { deadline: Date.now() + 1000 }), err => err.status === 503);
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 1000, 'did not wait past the deadline');

  await assert.rejects(sg.getInvoice('inv-1', { deadline: Date.now() - 1 }), /no time left/);
});

test('Storeganise: requests to one account run in series, across clients of companies sharing it', async () => {
  const { companies } = await loadConfig({ fresh: true });
  const propco = companies.find(c => c.code === 'propco');
  const a = storeganiseApi({ company: propco });
  const b = storeganiseApi({ company: { ...propco, id: 'other', code: 'propco' } });

  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 20));
    inFlight--;
    return new Response('{}', { status: 200 });
  };

  await Promise.all([a.getInvoice('1'), b.getInvoice('2'), a.getUser('u'), b.listInvoices({})]);
  assert.equal(maxInFlight, 1);
});

test('Storeganise: write-back reads only the custom fields it merges', async () => {
  const sg = await propcoClient();
  mockFetch([{ status: 200, body: { id: 'inv-1', customFields: {} } }, { status: 200, body: {} }]);
  await sg.updateInvoiceCustomFields('inv-1', { ei_status: 'sent' });
  assert.match(calls[0].url, /\/v1\/admin\/invoices\/inv-1\?include=customFields$/);
});
