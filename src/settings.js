import { many, one } from './db.js';

/**
 * Configuration read from the database and cached briefly, so an operator's change
 * to a setting, mapping row or series is picked up within a minute, no deploy
 * needed (FR-CFG-03, FR-CFG-04).
 */
const TTL_MS = 60 * 1000;

let cache = null;
let loadedAt = 0;

export async function loadConfig({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - loadedAt < TTL_MS) return cache;

  const [settingsRows, issuer, branches, series, docTypeRules, lineMappings, paymentMethods, companies, companySites] = await Promise.all([
    many('select key, value from einvoice.settings'),
    one('select * from einvoice.issuer where id = 1'),
    many('select * from einvoice.site_branches'),
    many('select * from einvoice.series'),
    many('select * from einvoice.doc_type_rules order by priority, id'),
    many('select * from einvoice.line_mappings order by priority, id'),
    many('select * from einvoice.payment_methods'),
    many('select * from einvoice.companies order by code'),
    many('select * from einvoice.company_sites'),
  ]);

  const settings = Object.fromEntries(settingsRows.map(row => [row.key, row.value]));

  cache = {
    settings,
    issuer,
    branches: Object.fromEntries(branches.map(row => [row.sg_site_id, row])),
    series: Object.fromEntries(series.map(row => [row.code, row])),
    docTypeRules,
    lineMappings,
    paymentMethods: Object.fromEntries(paymentMethods.map(row => [row.sg_method, row])),
    // Multi-company (scope §10); helpers in companies.js
    companies,
    companySites: Object.fromEntries(companySites.map(row => [row.sg_site_id, row.company_id])),
  };
  loadedAt = Date.now();

  return cache;
}

/** For tests, and after an operator action that must take effect immediately. */
export function clearConfigCache() {
  cache = null;
}

export async function getState(key) {
  const row = await one('select value from einvoice.runtime_state where key = $1', [key]);
  return row ? row.value : null;
}

export async function setState(key, value) {
  await one(
    `insert into einvoice.runtime_state (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
