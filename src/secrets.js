import config from '../config.js';
import { one } from './db.js';

/**
 * Credentials come from Supabase Vault (FR-CFG-01, FR-ERR-02) and are cached for a
 * few minutes so a rotated secret is picked up without a restart. They are never
 * logged: the audit log records requests without headers.
 *
 * Vault names (see README):
 *   sg_<code>_api_key, sg_<code>_webhook_secret   per company (scope §10.1),
 *     where <code> is einvoice.companies.code; read through getCompanySecrets()
 *   cron_secret,
 *   impact_uat_api_key, impact_production_api_key
 *     (the one key Impact issues per company; used by all three auth modes)
 */
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export async function getSecret(name, { required = true } = {}) {
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let value = null;

  try {
    const row = await one('select einvoice.get_secret($1) as value', [name]);
    value = row?.value || null;
  } catch (err) {
    // get_secret only exists on Supabase (Vault). Fall through to env if allowed.
    if (!config.allowEnvSecrets) throw err;
  }

  if (!value && config.allowEnvSecrets) value = process.env[name.toUpperCase()] || null;

  if (!value && required) throw new Error(`Secret "${name}" is not configured in Vault`);

  cache.set(name, { value, at: Date.now() });
  return value;
}

/**
 * A company's Storeganise credentials. Either may be null if not configured yet;
 * callers decide whether that is fatal.
 */
export async function getCompanySecrets(company) {
  const [sgApiKey, sgWebhookSecret] = await Promise.all([
    getSecret(`sg_${company.code}_api_key`, { required: false }),
    getSecret(`sg_${company.code}_webhook_secret`, { required: false }),
  ]);
  return { sgApiKey, sgWebhookSecret };
}

export function clearSecretCache() {
  cache.clear();
}
