-- Multi-company support, Storeganise side (scope §10): every job, poll cursor and
-- audit row belongs to a company, and each company reads invoices from its own
-- Storeganise account with its own credentials. Adding a company is rows plus
-- Vault secrets plus a webhook; no code change.
--
-- Issuer details, Impact credentials and series stay global for now (the only
-- company at go-live is Propco); they move per company with the Impact side.

create table einvoice.companies (
  id                uuid primary key default gen_random_uuid(),
  -- Used in the webhook URL (/sg-webhook/{code}) and the Vault secret names
  -- (sg_<code>_api_key, sg_<code>_webhook_secret), so kept to [a-z0-9_].
  code              text not null unique check (code ~ '^[a-z][a-z0-9_]*$'),
  legal_name        text not null,
  -- account: the company has its own Storeganise account.
  -- site:    several companies share one Storeganise account (same sg_api_url);
  --          each invoice belongs to the company its site is mapped to in
  --          company_sites.
  routing_mode      text not null default 'account' check (routing_mode in ('account', 'site')),
  sg_api_url        text,          -- e.g. https://<business>.storeganise.com/api
  sg_business_code  text,          -- add-on webhooks from any other business are refused
  active            boolean not null default true,
  paused            boolean not null default false,   -- FR-CFG-05 per company
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger companies_touch before update on einvoice.companies
  for each row execute function einvoice.touch_updated_at();

-- routing_mode = 'site' only. Storeganise site ids are globally unique, so a site
-- belongs to exactly one company.
create table einvoice.company_sites (
  sg_site_id   text primary key,
  company_id   uuid not null references einvoice.companies(id) on delete cascade,
  site_name    text
);

create index company_sites_company_idx on einvoice.company_sites (company_id);

-- Propco, the only company at go-live, takes over the single-company settings.
insert into einvoice.companies (code, legal_name, sg_api_url, sg_business_code)
select 'propco',
       coalesce((select registered_name from einvoice.issuer where id = 1), 'Gigantic Self Storage Propco One SA'),
       (select value #>> '{}' from einvoice.settings where key = 'sg_api_url'),
       (select value #>> '{}' from einvoice.settings where key = 'sg_business_code');

delete from einvoice.settings where key in ('sg_api_url', 'sg_business_code');

-- Storeganise add-on technical reference: retry network failures and 408 / 429 /
-- 5xx with backoff. Kept small: callers retry again later (worker, poll, webhook).
insert into einvoice.settings (key, value, description) values
  ('sg_retry_attempts', '2', 'Extra attempts for a Storeganise GET/PUT on a network error, 408, 429 or 5xx (backoff 1s, 3s; Retry-After honoured, max 10s)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Jobs: company_id is stamped at creation and never changes (§10.2).
-- One job per (company, invoice) (FR-CAP-02).
-- ---------------------------------------------------------------------------

alter table einvoice.jobs add column company_id uuid references einvoice.companies(id);
update einvoice.jobs set company_id = (select id from einvoice.companies where code = 'propco');
alter table einvoice.jobs alter column company_id set not null;

alter table einvoice.jobs drop constraint jobs_sg_invoice_id_kind_correction_key_key;
alter table einvoice.jobs add constraint jobs_company_invoice_key
  unique (company_id, sg_invoice_id, kind, correction_key);

create index jobs_company_idx on einvoice.jobs (company_id, status);

create function einvoice.jobs_company_fixed() returns trigger language plpgsql as $$
begin
  if new.company_id is distinct from old.company_id then
    raise exception 'A job''s company cannot change (job %)', old.id;
  end if;
  return new;
end $$;

create trigger jobs_company_fixed before update of company_id on einvoice.jobs
  for each row execute function einvoice.jobs_company_fixed();

-- FR-ERR-01: every log row carries company_id
alter table einvoice.audit_log add column company_id uuid;
update einvoice.audit_log a set company_id = j.company_id from einvoice.jobs j where j.id = a.job_id;
create index audit_log_company_idx on einvoice.audit_log (company_id, at);

-- The poll cursor is per company now (poll_cursor:<code>)
update einvoice.runtime_state set key = 'poll_cursor:propco' where key = 'poll_cursor';

-- ---------------------------------------------------------------------------
-- Queue functions, now company-aware
-- ---------------------------------------------------------------------------

drop function einvoice.refresh_invoice(text);
drop function einvoice.enqueue_invoice(text, text, text);

create function einvoice.enqueue_invoice(
  p_company_id uuid,
  p_sg_invoice_id text,
  p_event text,
  p_sg_site_id text default null
) returns uuid
language sql as $$
  insert into einvoice.jobs (company_id, sg_invoice_id, sg_site_id, last_event, last_event_at, needs_eval)
  values (p_company_id, p_sg_invoice_id, p_sg_site_id, p_event, now(), true)
  on conflict (company_id, sg_invoice_id, kind, correction_key) do update
     set needs_eval    = true,
         last_event    = excluded.last_event,
         last_event_at = excluded.last_event_at,
         sg_site_id    = coalesce(einvoice.jobs.sg_site_id, excluded.sg_site_id)
  returning id;
$$;

-- As before, plus: inactive companies are left alone entirely, and a paused
-- company's jobs are still evaluated but never transmitted (FR-CFG-05).
create or replace function einvoice.claim_jobs(
  p_limit int,
  p_lease_seconds int,
  p_transmit boolean
) returns setof einvoice.jobs
language sql as $$
  with c as (
    select j.id
      from einvoice.jobs j
      join einvoice.companies co on co.id = j.company_id and co.active
     where (j.locked_until is null or j.locked_until < now())
       and (
             j.needs_eval
          or j.writeback_pending
          or (p_transmit and not co.paused and j.status in ('pending', 'retry', 'sending', 'held') and j.next_attempt_at <= now())
          or (p_transmit and not co.paused and j.status = 'sent' and j.mark is null and j.next_attempt_at <= now())
       )
     order by j.needs_eval desc, j.next_attempt_at
     limit p_limit
     for update of j skip locked
  )
  update einvoice.jobs j
     set locked_until = now() + make_interval(secs => p_lease_seconds),
         lease_token = gen_random_uuid()
    from c
   where j.id = c.id
  returning j.*;
$$;

-- Ask the worker to re-read a Storeganise invoice for a company, creating the job
-- if it does not exist.
create function einvoice.refresh_invoice(p_company_code text, p_sg_invoice_id text)
returns uuid
language plpgsql as $$
declare
  cid uuid;
begin
  select id into cid from einvoice.companies where code = p_company_code;
  if cid is null then
    raise exception 'Unknown company "%"', p_company_code;
  end if;
  return einvoice.enqueue_invoice(cid, p_sg_invoice_id, 'operator.refresh');
end $$;

-- FR-CFG-05 per company. einvoice.set_paused() still pauses everything.
create function einvoice.set_company_paused(p_company_code text, p_paused boolean)
returns boolean
language plpgsql as $$
declare
  cid uuid;
begin
  update einvoice.companies set paused = p_paused where code = p_company_code returning id into cid;
  if cid is null then
    raise exception 'Unknown company "%"', p_company_code;
  end if;

  insert into einvoice.audit_log (kind, company_id, method, request)
  values ('operator', cid, 'set_company_paused', jsonb_build_object('company', p_company_code, 'paused', p_paused, 'by', current_user));

  return p_paused;
end $$;

-- routing_mode = 'site': an invoice whose site was not mapped to any company is
-- recorded as a failed job of the company whose webhook or poll found it, and
-- never sent. Once the site is added to company_sites, this replaces that job with
-- one for the right company (company_id never changes on a job, so it is a new
-- job). Only jobs that never reserved a number can be rerouted.
create function einvoice.reroute_unmapped_job(p_job_id uuid)
returns uuid
language plpgsql as $$
declare
  j einvoice.jobs%rowtype;
  target uuid;
  new_id uuid;
begin
  select * into j from einvoice.jobs where id = p_job_id for update;
  if not found or j.status_reason is distinct from 'unmapped_site' or j.number is not null then
    raise exception 'Job % is not an unmapped-site job', p_job_id;
  end if;

  select company_id into target from einvoice.company_sites where sg_site_id = j.sg_site_id;
  if target is null then
    raise exception 'Site % is still not mapped to a company (einvoice.company_sites)', j.sg_site_id;
  end if;

  delete from einvoice.jobs where id = p_job_id;
  new_id := einvoice.enqueue_invoice(target, j.sg_invoice_id, 'operator.reroute', j.sg_site_id);

  insert into einvoice.audit_log (kind, company_id, job_id, sg_invoice_id, method, request)
  values ('operator', target, new_id, j.sg_invoice_id, 'reroute_unmapped_job',
          jsonb_build_object('old_job', p_job_id, 'old_company', j.company_id, 'site', j.sg_site_id, 'by', current_user));

  return new_id;
end $$;

-- Dashboard views gain the company (columns appended, so replace keeps them valid)
create or replace view einvoice.v_attention as
select j.id, j.kind, j.sg_invoice_id, j.status, j.status_reason, j.last_error, j.attempts, j.next_attempt_at,
       j.series_code, j.number, j.mark, j.changed_after_issue, j.credit_required, j.updated_at,
       co.code as company
  from einvoice.jobs j
  join einvoice.companies co on co.id = j.company_id
 where j.status in ('held', 'failed_data', 'failed', 'retry')
    or j.changed_after_issue
    or j.credit_required is not null
    or j.writeback_pending
    or (j.status = 'sent' and j.mark is null)
    or j.delayed_code > 0
 order by j.updated_at desc;
