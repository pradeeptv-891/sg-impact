# Adding a company

This is how to connect a new company (a storage operator, or another legal entity of
an existing one) to the e-invoicing add-on. No code change and no redeploy are needed:
you run one SQL template, add four secrets and create a webhook.

It takes about 30 minutes. You need:

- access to the add-on's **Supabase project** (SQL editor)
- an **admin** login to the company's **Storeganise** account
- the address the add-on is deployed at (below: `https://<your-host>`)
- the company's **Impact API keys** (UAT and production), issued by Impact for the
  company's ΑΦΜ. They can be added later: until then the company's invoices are checked
  but not sent.

Each company issues under its own **issuer** (legal name, ΑΦΜ, address), **Impact API
key** and gapless **series**. The **mapping rules** are shared unless the accountant
gives a company its own (see the end of the template).

---

## 1. Choose how the company is routed

Pick one:

| Situation | `routing_mode` |
|---|---|
| The company has **its own Storeganise account** (its own `https://<business>.storeganise.com`) | `account` (most common) |
| Several companies **share one Storeganise account**, and each site belongs to one company | `site` |

Then pick a **company code**: short, lower-case letters, digits and `_`, e.g. `propco`,
`athens_north`. The code appears in the webhook URL and the secret names, and cannot be
changed later.

## 2. Create the company

Open `supabase/templates/new_company.sql`, fill in the values at the top, and run it in
the Supabase SQL editor:

- `v_code`, `v_legal_name` (the registered name, as on its documents)
- `v_sg_api_url`: `https://<business>.storeganise.com/api`
- `v_sg_business`: the Storeganise business code (the `<business>` part of the URL)
- `v_routing_mode`: from step 1
- `v_notify`: how Impact sends its copy (the legal document) to customers: `E` email
  (default), `A` archive only, `M` SMS/Viber, `C` email + SMS/Viber. SMS/Viber uses the
  Storeganise user's phone and needs a Greek mobile.
- Issuer: `v_afm` (9 digits, no `EL`), `v_tax_office`, address
- `v_series`: the series codes agreed with the accountant and their start numbers
  (1 for a new company)
- `v_sites`: for `site` mode only, every Storeganise site id that belongs to this
  company. Site ids are in Storeganise under **Sites**, or from `GET /api/v1/admin/sites`.

The company is created **paused**: invoices are picked up and checked, but nothing is
sent to Impact until you resume it in step 6. Running the file again updates the
company instead of adding a second one.

## 3. Storeganise: API key and custom fields

In the company's Storeganise account:

1. **API key:** Main Settings → Developer → API keys → **+**, role **admin** (the add-on
   writes results back to invoices, so read-only roles are not enough). Copy the key.
2. **Custom fields:** create them if the account does not have them yet.
   - **Invoice:** `ei_status`, `ei_doctype`, `ei_series`, `ei_number`, `ei_mark`, `ei_uid`,
     `ei_auth_code`, `ei_qr_url`, `ei_error`, `ei_sent_at`, `ei_credit_mark`
   - **User (customer):** `ei_is_business`, `ei_afm`, `ei_doy`, `ei_company_name`,
     `ei_address`, `ei_city`, `ei_postcode`, and optionally `ei_country` (default GR)
3. **Webhook secret:** shown in Main Settings → Developer, or in
   `GET /api/v1/admin/settings`. Copy it.

In `site` mode the shared account needs this only once, for whichever company holds the
webhook (step 4).

## 4. Secrets and webhook

**Secrets.** In the Supabase SQL editor, with your code in place of `<code>`:

```sql
select vault.create_secret('<storeganise admin api key>', 'sg_<code>_api_key');
select vault.create_secret('<storeganise webhook secret>', 'sg_<code>_webhook_secret');
-- Impact, for this company's ΑΦΜ (can be added later)
select vault.create_secret('<impact UAT api key>', 'impact_<code>_uat_api_key');
select vault.create_secret('<impact production api key>', 'impact_<code>_production_api_key');
```

Never paste keys into email or chat; use a one-time secret link to pass them on.

**Webhook.** In Storeganise: Main Settings → Developer → Webhooks → **+**

- URL: `https://<your-host>/sg-webhook/<code>`
- Events: `invoice.state.updated`, `invoice.payments.updated`, `invoice.deleted`,
  `user.updated`. **Not** `invoice.created`: unpaid invoices are pro formas and are never
  sent.
- Alert receivers: at least one email that someone reads. Storeganise emails it if
  the add-on does not answer a webhook after 3 tries.

In `site` mode, create **one** webhook for the shared account, using the code of any
company on it. Each invoice is routed by its site.

New companies and secrets are picked up within about a minute.

## 5. Check it works

1. In Storeganise, mark a test invoice **fully paid** (a partly paid invoice is ignored
   on purpose).
2. Within a minute or two it should appear here:

   ```sql
   select j.sg_invoice_id, j.status, j.status_reason, j.last_error, j.created_at
     from einvoice.jobs j join einvoice.companies c on c.id = j.company_id
    where c.code = '<code>' order by j.created_at desc limit 10;
   ```

   While the company is paused, a correct invoice waits as `pending`. `held` means
   customer data is missing (see `last_error`); fix the customer in Storeganise and it is
   re-checked straight away.
3. Check the webhook calls arrived and were accepted (status 200):

   ```sql
   select a.at, a.method, a.status_code, a.error
     from einvoice.audit_log a join einvoice.companies c on c.id = a.company_id
    where c.code = '<code>' and a.kind = 'webhook' order by a.at desc limit 20;
   ```

Even if no webhook arrives, the safety-net poll picks paid invoices up within about
10 minutes, so a job showing up only later points at the webhook setup.

4. Check the company's set-up:

   ```sql
   select * from einvoice.v_companies where code = '<code>';
   ```

   `issuer_configured` must be true and `active_series` above 0. A `pending` job whose
   `status_reason` names `impact_<code>_..._api_key` is waiting for that Vault secret.

**Impact test run (UAT).** With the UAT key in Vault and the environment on UAT, resume
the company (step 6) and send a few test invoices; their MARKs appear in `ei_mark`.
Customers are not contacted in UAT; to see the notifications, set
`uat_notification_emails` / `uat_notification_phones` (README, Customer notifications).
The environment (`impact_env`) is shared: switching it to production switches every
company, so every active company needs its production key first.

## 6. Go live

When the checks pass:

```sql
select einvoice.set_company_paused('<code>', false);
```

Pausing again at any time stops only this company. Its invoices keep queueing and go
out when it is resumed.

---

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| No webhook rows in `audit_log` at all | Webhook URL wrong, or company code mistyped | Check the URL ends in `/sg-webhook/<code>` exactly as in `einvoice.companies.code` |
| Webhook rows with status **404** | Unknown or inactive company code | Check the code; `select code, active from einvoice.companies;` |
| Webhook rows with status **400**, "Invalid signature" | `sg_<code>_webhook_secret` does not match the account's secret | Copy the secret again from Storeganise and update it in Vault |
| Webhook rows with status **400**, "Unexpected business" | The webhook was set up in a different Storeganise account than `sg_api_url` / `sg_business_code` | Fix the company row or the webhook |
| Webhook calls fail with **500**; Storeganise sends alert emails | A secret is missing in Vault, or Storeganise was slow or unreachable | Check both `sg_<code>_*` secrets exist. If they do, the poll catches up by itself |
| Job `failed`, "Unmapped site …" | `site` mode, and the invoice's site is not in `company_sites` | Add the site (re-run the template with it in `v_sites`), then `select einvoice.reroute_unmapped_job('<job id>');` |
| Job `failed`, "… belongs to company …" | `site` mode, and the site is mapped to a different company than the job's | Check `company_sites`; an invoice is only ever issued by the company its site belongs to |
| Job `held` | Business customer is missing ΑΦΜ, company name, city or postcode | Fix the customer in Storeganise; it is re-checked immediately |
| Errors mentioning `sg_<code>_api_key` | API key missing in Vault, or revoked in Storeganise | Create a new admin key and update the secret |
| Jobs stay `pending`, `status_reason` "Impact API key not configured …" | `impact_<code>_<env>_api_key` missing in Vault | Add it; the jobs go out within about 20 minutes |
| Jobs stay `new`, nothing evaluated | The company has no issuer row | Re-run the template with the issuer filled in |
| Job `failed – data`, "Issuer ΑΦΜ / API key rejected" | The Impact key does not belong to the company's ΑΦΜ, or the ΑΦΜ is not active at Impact | Check the key with Impact and `einvoice.issuer.afm`; then re-queue |

Everything that needs attention, for all companies:

```sql
select * from einvoice.v_attention;
```
