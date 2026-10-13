import storeganiseApi from './storeganise-api.js';

/**
 * Multi-company helpers (scope §10). Companies come from einvoice.companies via
 * loadConfig(), so adding one takes effect within a minute, no deploy.
 *
 * A Storeganise "account" is what one API key and one webhook cover:
 *   routing_mode = 'account'  the company alone
 *   routing_mode = 'site'     every active site-mode company with the same
 *                             sg_api_url; each invoice belongs to the company its
 *                             site is mapped to (einvoice.company_sites)
 */

export function companyByCode(cfg, code) {
  return cfg.companies.find(c => c.code === code) || null;
}

export function companyById(cfg, id) {
  return cfg.companies.find(c => c.id === id) || null;
}

function sameUrl(a, b) {
  return Boolean(a && b) && a.replace(/\/$/, '') === b.replace(/\/$/, '');
}

/** The active companies sharing `company`'s Storeganise account (itself included). */
export function accountCompanies(cfg, company) {
  if (company.routing_mode !== 'site') return [company];
  const group = cfg.companies.filter(c => c.active && c.routing_mode === 'site' && sameUrl(c.sg_api_url, company.sg_api_url));
  return group.some(c => c.id === company.id) ? group : [company, ...group];
}

/**
 * One entry per Storeganise account to poll: the account's companies, and the one
 * whose credentials and cursor are used (the first by code, so it is stable).
 */
export function pollAccounts(cfg) {
  const accounts = [];
  const seen = new Set();
  for (const company of cfg.companies) {
    if (!company.active || seen.has(company.id)) continue;
    const companies = accountCompanies(cfg, company);
    companies.forEach(c => seen.add(c.id));
    accounts.push({ owner: companies[0], companies });
  }
  return accounts;
}

/**
 * The company an invoice belongs to, given the company whose webhook or poll found
 * it. Account mode: that company. Site mode: the company the invoice's site is
 * mapped to, within the same Storeganise account; null if the site is unmapped.
 */
export function routeInvoice(cfg, company, siteId) {
  if (company.routing_mode !== 'site') return company;
  const companyId = siteId ? cfg.companySites[String(siteId)] : null;
  if (!companyId) return null;
  return accountCompanies(cfg, company).find(c => c.id === companyId) || null;
}

/**
 * One Storeganise client per company, kept so all of a company's calls share one
 * serial queue (and never queue behind another company's). Rebuilt if the
 * company's URL changes.
 */
const clients = new Map();

export function storeganiseFor(company) {
  const key = `${company.id}|${company.sg_api_url}`;
  let client = clients.get(key);
  if (!client) {
    for (const k of clients.keys()) if (k.startsWith(`${company.id}|`)) clients.delete(k);
    client = storeganiseApi({ company });
    clients.set(key, client);
  }
  return client;
}
