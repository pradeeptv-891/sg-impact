// Shared by the probe and the webhook sandbox: the add-on's real code on a
// throwaway in-memory database, reading a real Storeganise account, with every
// side effect blocked.
//
//   - Storeganise: GET only. Write-backs are recorded in `blockedWrites`; any
//     other write throws.
//   - Impact: never called. Transmission is paused, and the Impact stand-in throws.
//   - Supabase: never touched. PGlite runs the real migrations in memory.
//
// Import this before anything from src/: it sets the env the add-on expects.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// config.js insists on DATABASE_URL; nothing connects to it, the db is swapped below
process.env.DATABASE_URL ||= 'postgres://sandbox-not-used';

export async function createSandbox({ apiUrl, apiKey, businessCode = null, webhookSecret = null, ignoreVat = false, maxPages = 5 }) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { setDb } = await import('../../src/db.js');
  const { clearConfigCache, loadConfig } = await import('../../src/settings.js');
  const { default: storeganiseApi } = await import('../../src/storeganise-api.js');

  const pg = new PGlite();
  const migrations = path.join(root, 'supabase', 'migrations');
  for (const file of fs.readdirSync(migrations).sort()) {
    if (file.includes('supabase_platform')) continue; // Vault / pg_cron only exist on Supabase
    await pg.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  }
  setDb({ query: (text, params) => pg.query(text, params) });

  await pg.query(
    `update einvoice.companies set sg_api_url = $1, sg_business_code = $2 where code = 'propco'`,
    [apiUrl, businessCode],
  );
  // Stand-in for Vault, in memory only: the webhook checks signatures with this
  await pg.query(
    `create function einvoice.get_secret(p_name text) returns text language sql as $f$
       select case p_name when 'sg_propco_api_key' then ${literal(apiKey)}
                          when 'sg_propco_webhook_secret' then ${literal(webhookSecret)} end $f$`,
  );
  // A stand-in issuer so eligibility and mapping run; nothing is ever sent with it
  await pg.query(
    `insert into einvoice.issuer (registered_name, afm, tax_office, street, street_number, city, postal_code)
     values ('SANDBOX – not sent', '999645320', 'ΔΟΥ', 'Sandbox', '1', 'Αθήνα', '10000')`,
  );
  await pg.query(`select einvoice.set_paused(true)`);
  clearConfigCache();

  const cfg = await loadConfig({ fresh: true });
  const company = cfg.companies.find(c => c.code === 'propco');

  const stats = { requests: 0, vatRewritten: 0 };
  const blockedWrites = [];
  const listPages = [];
  const real = storeganiseApi({ company, apiKey });

  const sg = {
    async getInvoice(id, o) {
      stats.requests++;
      const raw = await real.getInvoice(id, o);
      return ignoreVat ? withGreekVat(raw, stats) : raw;
    },
    async getUser(id) { stats.requests++; return real.getUser(id); },
    async listInvoices(params) {
      if (listPages.length >= maxPages) {
        console.warn(`  (stopping after --max-pages ${maxPages}; raise it to see more)`);
        return [];
      }
      stats.requests++;
      const page = await real.listInvoices(params);
      listPages.push({ offset: params.offset, items: page });
      return page;
    },
    async updateInvoiceCustomFields(id, fields) {
      blockedWrites.push({ id, fields, at: new Date() });
      return { skipped: 'sandbox: write blocked' };
    },
    get() { throw new Error('sandbox: raw GET not used'); },
    post() { throw new Error('sandbox: writes are blocked'); },
    put() { throw new Error('sandbox: writes are blocked'); },
  };

  const impact = new Proxy({}, {
    get: (_, name) => () => { throw new Error(`sandbox: Impact.${String(name)} must never be called`); },
  });

  return { pg, cfg, company, sg, impact, stats, blockedWrites, listPages };
}

function literal(value) {
  return value === null || value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`;
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * --ignore-vat: test accounts often use non-Greek VAT rates, which the add-on
 * rightly refuses. Rewrites every taxable line to 24% (line, invoice and payment
 * totals recomputed so they still agree). Deposits and prepayments carry no VAT
 * and are kept; €0 invoices are left alone. Sandbox only: the add-on never does this.
 */
export function withGreekVat(raw, stats = {}) {
  if (!raw || Number(raw.total) === 0) return raw;
  const unit = Array.isArray(raw.entries) && raw.entries.length;
  const lines = unit ? raw.entries : Array.isArray(raw.items) ? raw.items : [];
  if (!lines.length) return raw;

  let net = 0;
  let vat = 0;
  for (const l of lines) {
    const qty = Number(l.qty ?? l.quantity ?? 1) || 0;
    const subtotal = l.subtotal ?? round2(Number(l.amount ?? l.price ?? 0) * qty);
    if (unit && ['prepayment', 'deposit'].includes(String(l.type).toLowerCase())) {
      net += Number(l.subtotal ?? subtotal);
      vat += Number(l.tax ?? 0);
      continue;
    }
    l.taxPct = 24;
    l.subtotal = subtotal;
    l.tax = round2(subtotal * 0.24);
    l.total = round2(subtotal + l.tax);
    net += subtotal;
    vat += l.tax;
  }

  const oldTotal = Number(raw.total) || 0;
  const total = round2(net + vat);
  Object.assign(raw, { subtotal: round2(net), tax: round2(vat), total, taxPercent: null });
  if (Number(raw.balance) <= 0) raw.balance = 0;
  // Payments scaled so a fully paid invoice stays fully paid at the new total
  const paid = (raw.payments || []).filter(p => Number(p.amount) > 0);
  if (oldTotal > 0 && paid.length) {
    let left = round2(total - Math.max(0, Number(raw.balance) || 0));
    paid.forEach((p, i) => {
      p.amount = i === paid.length - 1 ? left : round2((Number(p.amount) / oldTotal) * total);
      left = round2(left - p.amount);
    });
  }
  if (raw.amountPaid !== undefined) raw.amountPaid = round2(total - (Number(raw.balance) || 0));
  stats.vatRewritten = (stats.vatRewritten || 0) + 1;
  return raw;
}
