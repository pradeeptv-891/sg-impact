import config from '../config.js';
import { one } from './db.js';

/**
 * Credentials come from Supabase Vault (FR-CFG-01, FR-ERR-02) and are cached for a
 * few minutes so a rotated secret is picked up without a restart. They are never
 * logged: the audit log records requests without headers.
 *
 * Vault names (see README):
 *   sg_api_key, sg_webhook_secret, cron_secret,
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

export function clearSecretCache() {
  cache.clear();
}
