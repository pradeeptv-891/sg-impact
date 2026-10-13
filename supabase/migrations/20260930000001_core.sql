-- Impact e-Invoicing add-on: core schema.
--
-- Everything lives in a private `einvoice` schema so none of it is exposed through
-- Supabase's auto-generated REST API. The Node service connects with DATABASE_URL.

create schema if not exists einvoice;

-- ---------------------------------------------------------------------------
-- Configuration (FR-CFG-01..05). Changes take effect without a deploy; the service
-- re-reads these tables every minute.
-- ---------------------------------------------------------------------------

create table einvoice.settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now()
);

-- Exactly one issuer (FR-CFG-02).
create table einvoice.issuer (
  id               int primary key default 1 check (id = 1),
  registered_name  text not null,
  afm              text not null,           -- 9 digits, no EL prefix
  tax_office       text,
  country_code     text not null default 'GR',
  street           text,
  street_number    text,
  city             text,
  postal_code      text,
  default_branch   int  not null default 0,
  updated_at       timestamptz not null default now()
);

-- Optional per-site branch code and series suffix (FR-CFG-02 / FR-CFG-04).
create table einvoice.site_branches (
  sg_site_id     text primary key,
  site_name      text,
  branch         int  not null default 0,
  series_suffix  text not null default ''
);

-- Gapless counters, one row per series (FR-CFG-04 / FR-NUM-01).
create table einvoice.series (
  code          text primary key,
  description   text,
  next_number   bigint not null default 1 check (next_number >= 1),
  active        boolean not null default true,
  updated_at    timestamptz not null default now()
);

-- Which myDATA document type and series to use (FR-MAP-01, FR-CAP-05).
-- `null` in a match column means "any".
create table einvoice.doc_type_rules (
  id                   serial primary key,
  kind                 text not null check (kind in ('invoice', 'credit')),
  customer_kind        text check (customer_kind in ('b2b', 'b2c')),
  region               text check (region in ('GR', 'EU', 'NON_EU')),
  nature               text check (nature in ('services', 'goods', 'mixed')),
  invoice_type_code    text not null,       -- e.g. 2.1, 11.2, 5.1
  invoice_type_name    text not null,       -- Impact `invoiceType`
  document_type_code   text not null default 'INVOICE',
  series_code          text not null,
  trigger              text not null default 'on_issue' check (trigger in ('on_issue', 'on_payment')),
  priority             int  not null default 100,
  approved             boolean not null default false,
  notes                text
);

-- Storeganise line → VAT / income classification (FR-CFG-03, FR-MAP-03).
-- `null` in a match column means "any". Most specific match wins, then lowest priority.
create table einvoice.line_mappings (
  id                            serial primary key,
  customer_kind                 text check (customer_kind in ('b2b', 'b2c')),
  line_type                     text,
  accounting_code               text,
  priority                      int  not null default 100,
  exclude                       boolean not null default false,  -- e.g. deposits held, not earned
  nature                        text not null default 'services' check (nature in ('services', 'goods')),
  vat_category_code             int,        -- override; otherwise derived from the VAT rate
  vat_exemption_code            int,        -- required when vat_category_code = 7
  classification_type_code      text,
  classification_category_code  text not null,
  approved                      boolean not null default false,
  notes                         text
);

-- Storeganise payment method → myDATA payment method code (FR-MAP-06).
create table einvoice.payment_methods (
  sg_method     text primary key,     -- lower-cased; '*' is the fallback
  mydata_code   int  not null,
  mydata_name   text not null,
  approved      boolean not null default false,
  notes         text
);

-- ---------------------------------------------------------------------------
-- Operational data
-- ---------------------------------------------------------------------------

create table einvoice.jobs (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null default 'invoice' check (kind in ('invoice', 'credit_note')),
  sg_invoice_id        text not null,
  -- '' for the invoice itself; 'full' or a refund payment id for credit notes
  correction_key       text not null default '',
  parent_job_id        uuid references einvoice.jobs(id),
  sg_site_id           text,

  status               text not null default 'new' check (status in (
                         'new', 'waiting', 'pending', 'sending', 'retry', 'sent',
                         'held', 'failed_data', 'failed', 'skipped', 'credited')),
  status_reason        text,

  -- Locked once a number is reserved (FR-NUM-02)
  customer_kind        text,
  invoice_type_code    text,
  series_code          text references einvoice.series(code),
  number               bigint,
  date_issued          timestamptz,

  -- myDATA identifiers
  mark                 text,
  uid                  text,
  auth_code            text,
  qr_url               text,
  impact_status        text,       -- Impact's document status: SUBMITTED | PENDING | INVALID …

  -- Offline issuance (Impact offline QR): 0 = normal, 1 = issuer↔provider failure,
  -- 2 = provider↔AADE failure. Once set, the document is resent unchanged with it.
  delayed_code         int not null default 0 check (delayed_code in (0, 1, 2)),
  offline_qr_url       text,

  amount_net           numeric(12, 2),
  amount_vat           numeric(12, 2),
  amount_gross         numeric(12, 2),

  attempts             int not null default 0,
  next_attempt_at      timestamptz not null default now(),
  needs_eval           boolean not null default true,
  locked_until         timestamptz,
  lease_token          uuid,       -- set per claim; lets a worker detect a lapsed lease

  last_error           text,
  last_error_detail    jsonb,

  sg_snapshot          jsonb,      -- invoice + customer as sent, so a deleted invoice can still be issued
  sg_fingerprint       text,       -- amounts hash at issue, for post-issue change detection (FR-COR-03)
  changed_after_issue  boolean not null default false,
  credit_required      text,       -- set when a credit is needed but credit notes are disabled
  credit_amount        numeric(12, 2),  -- credit notes: gross amount credited
  credit_reason        text,            -- credit notes: why (voided, deleted, refund …)
  handled_refunds      text[] not null default '{}',

  request              jsonb,      -- last payload sent to Impact
  response             jsonb,      -- last Impact response

  writeback_pending    boolean not null default false,
  written_back         jsonb,      -- last custom-field values written to Storeganise

  last_event           text,
  last_event_at        timestamptz,
  sent_at              timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (sg_invoice_id, kind, correction_key),                 -- FR-CAP-02
  unique (series_code, number),                                  -- FR-NUM-01
  check ((number is null) = (series_code is null)),
  check (kind = 'invoice' or parent_job_id is not null)
);

create index jobs_due_idx on einvoice.jobs (next_attempt_at)
  where status in ('pending', 'retry', 'sending', 'held');
create index jobs_eval_idx on einvoice.jobs (created_at) where needs_eval or writeback_pending;
create index jobs_status_idx on einvoice.jobs (status);
create index jobs_parent_idx on einvoice.jobs (parent_job_id);

-- FR-ERR-01: every webhook, Impact request/response and Storeganise write-back.
create table einvoice.audit_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  kind            text not null,     -- webhook | impact | storeganise | operator | system
  job_id          uuid,
  sg_invoice_id   text,
  method          text,
  url             text,
  status_code     int,
  duration_ms     int,
  request         jsonb,
  response        jsonb,
  error           text
);

create index audit_log_job_idx on einvoice.audit_log (job_id, at);
create index audit_log_invoice_idx on einvoice.audit_log (sg_invoice_id, at);
create index audit_log_at_idx on einvoice.audit_log (at);

-- Small key/value store for cursors (e.g. the safety-net poll's updatedAfter).
create table einvoice.runtime_state (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- FR-REC-01
create table einvoice.reconciliation_runs (
  id            bigserial primary key,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  window_from   timestamptz not null,
  window_to     timestamptz not null,
  status        text not null default 'running' check (status in ('running', 'ok', 'issues', 'error')),
  summary       jsonb,
  error         text
);

create table einvoice.reconciliation_issues (
  id              bigserial primary key,
  run_id          bigint not null references einvoice.reconciliation_runs(id) on delete cascade,
  issue           text not null,   -- missing_job | not_transmitted | failed_job | missing_in_impact |
                                   -- unknown_in_impact | duplicate_in_impact | mismatch | number_unsent
  sg_invoice_id   text,
  job_id          uuid,
  series_code     text,
  number          bigint,
  details         jsonb,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index reconciliation_issues_open_idx on einvoice.reconciliation_issues (created_at) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create function einvoice.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger jobs_touch before update on einvoice.jobs
  for each row execute function einvoice.touch_updated_at();
create trigger settings_touch before update on einvoice.settings
  for each row execute function einvoice.touch_updated_at();
create trigger series_touch before update on einvoice.series
  for each row execute function einvoice.touch_updated_at();
create trigger issuer_touch before update on einvoice.issuer
  for each row execute function einvoice.touch_updated_at();

-- Lock the schema down: only the service's own connection role (postgres / service
-- role) should touch it.
revoke all on schema einvoice from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema einvoice from anon, authenticated';
  end if;
end $$;
