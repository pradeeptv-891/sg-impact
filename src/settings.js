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

  const [settingsRows, issuers, branches, series, docTypeRules, lineMappings, paymentMethods, companies, companySites] = await Promise.all([
    many('select key, value from einvoice.settings'),
    many('select * from einvoice.issuer'),
    many('select * from einvoice.site_branches'),
    many('select * from einvoice.series'),
    // A company's own rows sort before shared ones, so they win a tie (see forCompany)
    many('select * from einvoice.doc_type_rules order by (company_id is null), priority, id'),
    many('select * from einvoice.line_mappings order by (company_id is null), priority, id'),
    many('select * from einvoice.payment_methods order by (company_id is null), id'),
    many('select * from einvoice.companies order by code'),
    many('select * from einvoice.company_sites'),
  ]);

  const settings = Object.fromEntries(settingsRows.map(row => [row.key, row.value]));

  cache = {
    settings,
    branches: Object.fromEntries(branches.map(row => [row.sg_site_id, row])),
    // Per company (scope §10); forCompany() gives one company's view of these
    all: { issuers, series, docTypeRules, lineMappings, paymentMethods },
    // Multi-company (scope §10); helpers in companies.js
    companies,
    companySites: Object.fromEntries(companySites.map(row => [row.sg_site_id, row.company_id])),
  };
  loadedAt = Date.now();

  return cache;
}

/**
 * One company's configuration: its issuer, its series, and the mapping that
 * applies to it (its own rows plus the shared ones, company_id null). This is the
 * `cfg` the mapper, the rules and the processors work with.
 *
 * Mapping rows arrive with the company's own rows ahead of shared rows, and the
 * rule lookups keep the first row at the best score, so a company row overrides a
 * shared row that matches equally well, whatever their priorities.
 */
export function forCompany(cfg, company) {
  const id = company?.id ?? null;
  const applies = row => row.company_id === null || row.company_id === undefined || row.company_id === id;
  const { all } = cfg;

  const paymentMethods = {};
  // Company rows come first: the first row for a method wins
  for (const row of all.paymentMethods.filter(applies)) {
    if (!paymentMethods[row.sg_method]) paymentMethods[row.sg_method] = row;
  }

  return {
    ...cfg,
    company,
    issuer: all.issuers.find(row => row.company_id === id) || null,
    series: Object.fromEntries(all.series.filter(row => row.company_id === id).map(row => [row.code, row])),
    docTypeRules: all.docTypeRules.filter(applies),
    lineMappings: all.lineMappings.filter(applies),
    paymentMethods,
  };
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
