-- Add a company (see ONBOARDING.md). Run in the Supabase SQL editor.
-- Not a migration: edit the values in the DECLARE block, then run the file once.
-- Safe to re-run: an existing company with the same code is updated, not duplicated.

do $$
declare
  -- 1. The company --------------------------------------------------------------
  v_code          text := 'newco';                 -- lower-case letters, digits, _ ; used in the webhook URL and secret names
  v_legal_name    text := 'New Company SA';
  v_sg_api_url    text := 'https://newco.storeganise.com/api';
  v_sg_business   text := 'newco';                 -- the Storeganise business code
  v_routing_mode  text := 'account';               -- 'account' (own Storeganise account) or 'site' (shared account)

  -- How Impact sends its copy (the legal document) to the customer:
  -- 'E' email (default), 'A' archive only, 'M' SMS/Viber, 'C' email + SMS/Viber
  v_notify        text := 'E';

  -- 2. Issuer: the legal entity on the documents (as registered with AADE) -------
  v_afm           text := '000000000';             -- 9 digits, no EL prefix
  v_tax_office    text := 'ΔΟΥ ...';
  v_street        text := '...';
  v_street_no     text := '...';
  v_city          text := '...';
  v_postcode      text := '00000';

  -- 3. Series: gapless counters of this company. Codes as agreed with the accountant;
  --    the same codes as Propco are fine (each company has its own counters).
  --    Set a start number only when continuing a series used elsewhere before.
  v_series        jsonb := '{"TPY": 1, "TP": 1, "APY": 1, "ALP": 1, "PT": 1, "PSL": 1}';

  -- 4. Sites, only when v_routing_mode = 'site' -----------------------------------
  --    Storeganise site id => site name. Leave empty for 'account'.
  v_sites         jsonb := '{}';                   -- e.g. '{"64f0c2...": "Athens North"}'

  v_id uuid;
  v_site record;
  v_s record;
begin
  insert into einvoice.companies (code, legal_name, sg_api_url, sg_business_code, routing_mode, transmission_method, active, paused)
  values (v_code, v_legal_name, v_sg_api_url, v_sg_business, v_routing_mode, v_notify, true, true)   -- starts paused: nothing is sent yet
  on conflict (code) do update
     set legal_name = excluded.legal_name,
         sg_api_url = excluded.sg_api_url,
         sg_business_code = excluded.sg_business_code,
         routing_mode = excluded.routing_mode,
         transmission_method = excluded.transmission_method
  returning id into v_id;

  insert into einvoice.issuer (company_id, registered_name, afm, tax_office, street, street_number, city, postal_code)
  values (v_id, v_legal_name, v_afm, v_tax_office, v_street, v_street_no, v_city, v_postcode)
  on conflict (company_id) do update
     set registered_name = excluded.registered_name, afm = excluded.afm, tax_office = excluded.tax_office,
         street = excluded.street, street_number = excluded.street_number, city = excluded.city,
         postal_code = excluded.postal_code;

  -- New series only; an existing counter is never moved by re-running this file
  for v_s in select key, value::bigint as start from jsonb_each_text(v_series) loop
    insert into einvoice.series (company_id, code, description, next_number)
    select v_id, v_s.key, p.description, v_s.start
      from (select max(description) as description from einvoice.series where code = v_s.key) p
    on conflict (company_id, code) do nothing;
  end loop;

  for v_site in select key, value #>> '{}' as name from jsonb_each(v_sites) loop
    insert into einvoice.company_sites (sg_site_id, company_id, site_name)
    values (v_site.key, v_id, v_site.name)
    on conflict (sg_site_id) do update set company_id = excluded.company_id, site_name = excluded.site_name;
  end loop;

  raise notice 'Company % ready (id %). Webhook URL: https://<your-host>/sg-webhook/%', v_code, v_id, v_code;
end $$;

-- 5. Secrets (Supabase Vault). Replace newco with the code above and paste the values.
-- select vault.create_secret('<storeganise admin api key>', 'sg_newco_api_key');
-- select vault.create_secret('<storeganise webhook secret>', 'sg_newco_webhook_secret');
-- The company's own Impact API keys (issued by Impact for this ΑΦΜ):
-- select vault.create_secret('<impact UAT api key>', 'impact_newco_uat_api_key');
-- select vault.create_secret('<impact production api key>', 'impact_newco_production_api_key');

-- Mapping is shared by default. Only if the accountant gives this company different
-- treatment, add rows with company_id = this company's id to einvoice.line_mappings,
-- einvoice.doc_type_rules or einvoice.payment_methods; they override the shared rows.

-- 6. When the checks in ONBOARDING.md pass, start sending:
-- select einvoice.set_company_paused('newco', false);
