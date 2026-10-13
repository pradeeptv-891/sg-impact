// Env comes from the host (Render/Fly/Heroku config vars etc).
// Locally: `npm run dev` loads .env via node --env-file.
//
// Only bootstrap values live in env. Business configuration lives in the database
// (einvoice.settings and the mapping tables) and credentials live in Supabase
// Vault, so neither needs a deploy to change (FR-CFG-01, FR-CFG-03).
const env = process.env;

const config = {
  port: Number(env.PORT) || 3000,

  // Supabase Postgres connection string (Settings → Database → Connection string,
  // "Session pooler", port 5432). Transactions and row locks need a session.
  databaseUrl: env.DATABASE_URL,
  databaseSsl: env.DATABASE_SSL !== 'false',

  // Run the worker, poll and reconciliation on timers inside this process instead
  // of waiting for pg_cron to call /jobs/*. Handy locally; leave off in production.
  inProcessScheduler: env.INPROCESS_SCHEDULER === 'true',

  // Secrets are read from Supabase Vault. For local development only, they can be
  // supplied as env vars instead (see .env.example); Vault wins when both exist.
  allowEnvSecrets: env.ALLOW_ENV_SECRETS === 'true',

  debug: env.DEBUG === 'true',
};

if (!config.databaseUrl && env.NODE_ENV !== 'test') {
  throw new Error('Missing required env var: DATABASE_URL');
}

export default config;
