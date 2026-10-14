-- Multi-company support, Impact side (scope §10): each company issues under its
-- own ΑΦΜ, with its own Impact API key, its own gapless series and, where it
-- differs, its own mapping. Propco takes over everything that was global.
--
-- Impact API keys are per company in Vault: impact_<code>_uat_api_key and
-- impact_<code>_production_api_key. A company without a key for the current
-- environment has its invoices evaluated but never sent.

-- ---------------------------------------------------------------------------
-- Issuer: one per company (FR-CFG-02)
-- ---------------------------------------------------------------------------

alter table einvoice.issuer add column company_id uuid references einvoice.companies(id) on delete cascade;
update einvoice.issuer set company_id = (select id from einvoice.companies where code = 'propco');
alter table einvoice.issuer drop column id;     -- drops the single-row primary key and check
alter table einvoice.issuer alter column company_id set not null;
alter table einvoice.issuer add primary key (company_id);

-- ---------------------------------------------------------------------------
-- Series: gapless per company. Two companies may use the same code (e.g. TPY);
-- each has its own counter. The UID Impact checks includes the issuer ΑΦΜ, so
-- equal series and numbers across companies never collide.
-- ---------------------------------------------------------------------------

alter table einvoice.jobs drop constraint jobs_series_code_fkey;
alter table einvoice.jobs drop constraint jobs_series_code_number_key;

alter table einvoice.series add column company_id uuid references einvoice.companies(id) on delete cascade;
update einvoice.series set company_id = (select id from einvoice.companies where code = 'propco');
alter table einvoice.series alter column company_id set not null;
alter table einvoice.series drop constraint series_pkey;
alter table einvoice.series add primary key (company_id, code);

alter table einvoice.jobs add constraint jobs_series_fkey
  foreign key (company_id, series_code) references einvoice.series (company_id, code);
alter table einvoice.jobs add constraint jobs_company_series_number_key
  unique (company_id, series_code, number);                     -- FR-NUM-01

create or replace function einvoice.reserve_job_number(
  p_job_id uuid,
  p_series text,
  p_invoice_type_code text,
  p_customer_kind text
) returns table (series_code text, number bigint, date_issued timestamptz)
language plpgsql as $$
declare
  j einvoice.jobs%rowtype;
  n bigint;
begin
  select * into j from einvoice.jobs where id = p_job_id for update;
  if not found then
    raise exception 'Job % not found', p_job_id;
  end if;

  if j.number is not null then
    return query select j.series_code, j.number, j.date_issued;
    return;
  end if;

  update einvoice.series s
     set next_number = s.next_number + 1
   where s.company_id = j.company_id and s.code = p_series and s.active
  returning s.next_number - 1 into n;

  if n is null then
    raise exception 'Series "%" is not configured or not active for this company', p_series;
  end if;

  update einvoice.jobs
     set series_code = p_series,
         number = n,
         date_issued = now(),
         invoice_type_code = p_invoice_type_code,
         customer_kind = p_customer_kind
   where id = p_job_id;

  return query select p_series, n, now();
end $$;

drop view einvoice.v_series;
create view einvoice.v_series as
select co.code as company,
       s.code,
       s.next_number,
       s.active,
       count(j.id) filter (where j.status in ('sent', 'credited')) as issued,
       array_agg(j.number order by j.number) filter (
         where j.status not in ('sent', 'credited')) as reserved_not_issued,
       (select array_agg(g order by g)
          from generate_series(1, s.next_number - 1) g
         where not exists (select 1 from einvoice.jobs x
                            where x.company_id = s.company_id and x.series_code = s.code and x.number = g)
       ) as gaps
  from einvoice.series s
  join einvoice.companies co on co.id = s.company_id
  left join einvoice.jobs j on j.company_id = s.company_id and j.series_code = s.code
 group by co.code, s.company_id, s.code, s.next_number, s.active
 order by co.code, s.code;

-- ---------------------------------------------------------------------------
-- Mapping: shared by default (company_id null), overridable per company. A
-- company's own row wins over a shared row that matches equally well.
-- ---------------------------------------------------------------------------

alter table einvoice.doc_type_rules add column company_id uuid references einvoice.companies(id) on delete cascade;
alter table einvoice.line_mappings  add column company_id uuid references einvoice.companies(id) on delete cascade;

alter table einvoice.payment_methods drop constraint payment_methods_pkey;
alter table einvoice.payment_methods add column id serial primary key;
alter table einvoice.payment_methods add column company_id uuid references einvoice.companies(id) on delete cascade;
create unique index payment_methods_company_method_key
  on einvoice.payment_methods (coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid), sg_method);

-- ---------------------------------------------------------------------------
-- Customer notifications (Impact: Customer Notifications), per company.
-- Impact's copy is the legal document; the customer gets it from Impact.
--   E  email with a link to the document (default)
--   A  archive only, nothing sent
--   M  SMS / Viber to the customer's mobile
--   C  email and SMS / Viber
-- A customer without the contact a method needs falls back (C → E or M, M → E,
-- E → A); a missing contact never stops the document being issued.
-- ---------------------------------------------------------------------------

alter table einvoice.companies add column transmission_method text not null default 'E'
  check (transmission_method in ('E', 'A', 'M', 'C'));

delete from einvoice.settings where key = 'distribution_enabled';

insert into einvoice.settings (key, value, description) values
  ('uat_notification_emails', '[]', 'Outside production, Impact notifications go to these addresses instead of customers. Empty = no email is sent in UAT.'),
  ('uat_notification_phones', '[]', 'Outside production, SMS / Viber goes to these numbers (+3069…) instead of customers. Empty = none sent in UAT.')
on conflict (key) do nothing;

-- Dashboard: what each company still needs before it can send
create view einvoice.v_companies as
select co.code,
       co.legal_name,
       co.active,
       co.paused,
       co.routing_mode,
       co.transmission_method,
       i.afm is not null as issuer_configured,
       i.afm as issuer_afm,
       (select count(*) from einvoice.series s where s.company_id = co.id and s.active) as active_series
  from einvoice.companies co
  left join einvoice.issuer i on i.company_id = co.id
 order by co.code;
