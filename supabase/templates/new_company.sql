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

  -- 2. Sites, only when v_routing_mode = 'site' -----------------------------------
  --    Storeganise site id => site name. Leave empty for 'account'.
  v_sites         jsonb := '{}';                   -- e.g. '{"64f0c2...": "Athens North"}'

  v_id uuid;
  v_site record;
begin
  insert into einvoice.companies (code, legal_name, sg_api_url, sg_business_code, routing_mode, active, paused)
  values (v_code, v_legal_name, v_sg_api_url, v_sg_business, v_routing_mode, true, true)   -- starts paused: nothing is sent yet
  on conflict (code) do update
     set legal_name = excluded.legal_name,
         sg_api_url = excluded.sg_api_url,
         sg_business_code = excluded.sg_business_code,
         routing_mode = excluded.routing_mode
  returning id into v_id;

  for v_site in select key, value #>> '{}' as name from jsonb_each(v_sites) loop
    insert into einvoice.company_sites (sg_site_id, company_id, site_name)
    values (v_site.key, v_id, v_site.name)
    on conflict (sg_site_id) do update set company_id = excluded.company_id, site_name = excluded.site_name;
  end loop;

  raise notice 'Company % ready (id %). Webhook URL: https://<your-host>/sg-webhook/%', v_code, v_id, v_code;
end $$;

-- 3. Secrets (Supabase Vault). Replace newco with the code above and paste the values.
-- select vault.create_secret('<storeganise admin api key>', 'sg_newco_api_key');
-- select vault.create_secret('<storeganise webhook secret>', 'sg_newco_webhook_secret');

-- 4. When the checks in ONBOARDING.md pass, start sending:
-- select einvoice.set_company_paused('newco', false);
