-- Supabase platform pieces: Vault secrets (FR-CFG-01, FR-ERR-02) and pg_cron
-- scheduling via pg_net. Kept separate from the core schema so the core can be
-- tested on plain Postgres.

create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

-- Reads one secret from Vault. Secrets are created by the operator, e.g.
--   select vault.create_secret('<value>', 'impact_uat_api_key');
-- Names used by the service are listed in the README.
create function einvoice.get_secret(p_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;

revoke all on function einvoice.get_secret(text) from public;

-- Schedules the three recurring jobs against the deployed service. pg_net posts to
-- the service; the service checks the x-cron-secret header against the Vault
-- secret `cron_secret`. Re-running this replaces the existing schedules.
--
--   select einvoice.schedule_jobs('https://einvoice-addon.example.com');
create function einvoice.schedule_jobs(
  p_app_url text,
  p_poll_every text default '*/10 * * * *',
  p_reconcile_at text default '30 2 * * *'     -- 02:30 UTC, after the nightly invoice run
) returns void
language plpgsql as $$
declare
  call text := $f$
    select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', einvoice.get_secret('cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 10000
    );
  $f$;
  base text := rtrim(p_app_url, '/');
begin
  perform cron.unschedule(jobname) from cron.job
    where jobname in ('einvoice-worker', 'einvoice-poll', 'einvoice-reconcile', 'einvoice-purge-audit');

  perform cron.schedule('einvoice-worker', '* * * * *', format(call, base || '/jobs/worker'));
  perform cron.schedule('einvoice-poll', p_poll_every, format(call, base || '/jobs/poll'));
  perform cron.schedule('einvoice-reconcile', p_reconcile_at, format(call, base || '/jobs/reconcile'));
  perform cron.schedule('einvoice-purge-audit', '15 3 * * *', 'select einvoice.purge_audit_log()');
end $$;

create function einvoice.unschedule_jobs()
returns void
language sql as $$
  select cron.unschedule(jobname) from cron.job
   where jobname in ('einvoice-worker', 'einvoice-poll', 'einvoice-reconcile', 'einvoice-purge-audit');
$$;
