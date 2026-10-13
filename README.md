# Impact e-Invoicing (myDATA) add-on for Storeganise

Every invoice issued in Storeganise for this operator becomes a myDATA-compliant
document, sent through IMPACT INVOICING. The MARK, UID, authentication code and
QR/document link are written back to the Storeganise invoice. Corrections go out
as credit notes, and everything is reconciled nightly.

Built from the Storeganise add-on boilerplate (Node 20+, Express) and uses
Supabase Postgres for jobs, numbering, configuration and the audit log. pg_cron
drives the schedule and Vault holds the secrets. There is no UI. Staff see results
on the invoice (`ei_*` custom fields), and operators use the Supabase dashboard.

```
Storeganise ──webhook──▶ /webhook ──▶ einvoice.jobs (one per invoice)
     ▲                                     │
     │ ei_* custom fields                  ▼   pg_cron → /jobs/worker (every minute)
     └──────────────────── worker: read invoice → eligibility → map → validate
                                   → reserve number → POST /invoice/json → result
                           /jobs/poll       (every 10 min, missed webhooks)
                           /jobs/reconcile  (nightly, Storeganise ↔ add-on ↔ Impact)
```

## How it works

1. **Capture (FR-CAP).** An unpaid invoice is a pro forma: nothing happens in the
   add-on until it is **fully paid** (FRD v1.3). `invoice.state.updated` and
   `invoice.payments.updated` are signature-checked (base64 HMAC-SHA256,
   `sg-signature`); for an invoice not tracked yet the webhook reads it back and
   creates one job per invoice only if it is fully paid (state `paid`, or balance
   ≤ 0). `invoice.created` is ignored, and `invoice.deleted` only matters for an
   invoice that already has a job (credit note). Nothing is sent to Impact inside
   the request. The safety-net poll picks up any paid invoice Storeganise failed
   to deliver.
2. **Eligibility.** The worker checks "fully paid" again before reserving a number,
   for every document type, so a payment reversed in the meantime is never sent.
   Void-before-issue, zero-value and deposit-only invoices are skipped. A business
   customer with missing or invalid tax data is **held**: it is never sent as B2C,
   and it is re-checked hourly and on every event.
3. **Mapping (FR-MAP).** `src/mydata/normalize.js` is the only file that knows
   Storeganise's field names. `src/mydata/mapper.js` builds Impact's JSON: it
   picks the document type, maps each line through `einvoice.line_mappings`,
   folds discounts into lines at the same VAT rate, excludes deposits, and builds
   the VAT analysis and payment methods. Transmission is blocked if the totals
   differ from Storeganise by more than €0.01.
4. **Numbering (FR-NUM).** The document is validated first. Only then is the
   next number in its series reserved, atomically (`einvoice.reserve_job_number`),
   and saved on the job. Every retry reuses that number and it is never released,
   so a document that fails validation never uses one up.
5. **Transmission (FR-TX).** Documents follow Impact's official JSON samples
   (PascalCase EliseCoreDocument), are sent with `IAPRSignPolicy` 2 (STRICT) and
   `TransmissionMethod: "A"`, so Impact archives them and does not email anyone
   unless distribution is switched on. How each Impact response is handled:
   - 201 `SUBMITTED`: marked sent, and the MARK, UID, authentication code and QR `url` are written back.
   - 201 `PENDING` (only with sign policy 0): marked sent; the MARK is looked up every 15 minutes until AADE assigns it.
   - 201 `INVALID` (only with sign policy 1): marked failed – data.
   - 400: marked failed – data, with AADE's own message from `myDataErrors`. There is no automatic retry; it needs an operator re-queue.
   - 401: the token is refreshed and the call retried once.
   - 408 (AADE unreachable, or the same UID still processing), 5xx, timeouts: retried with exponential backoff, 8 attempts over most of a day.
   - 409: already at AADE. Impact returns the same SignatureResponse, so it's treated as a success.
6. **Corrections (FR-COR).** A sent invoice that is later edited is flagged,
   never re-sent. A void, delete or refund creates a credit note (5.1 for B2B,
   11.4 for B2C) with `CorrelatedInvoices: [<original MARK>]`, in its own series.
   Credit notes are **off by default** because FR-COR-01 is still TBC. While they
   are off, the invoice is flagged "credit note required". Impact has no
   cancellation API for invoices (only for delivery notes), so FR-COR-04 is met by
   credit notes.
7. **Reconciliation (FR-REC).** Nightly, it looks for issued invoices with no job
   (and queues them), jobs stuck or failed, documents missing from Impact,
   documents in Impact that the add-on doesn't know about, duplicates, and
   MARK/amount mismatches. Results go to `einvoice.reconciliation_issues`.

## Setup

### 1. Supabase (Pro plan, EU region)

```bash
supabase link --project-ref <ref>
supabase db push            # applies supabase/migrations
```

Add the secrets to Vault (SQL editor):

```sql
select vault.create_secret('<storeganise admin api key>', 'sg_api_key');
select vault.create_secret('<webhook secret set in the add-on config>', 'sg_webhook_secret');
select vault.create_secret('<long random string>', 'cron_secret');
select vault.create_secret('<impact UAT api key>', 'impact_uat_api_key');
-- production, before go-live:
select vault.create_secret('<impact production api key>', 'impact_production_api_key');
```

Configure the issuer and the Storeganise account:

```sql
insert into einvoice.issuer (registered_name, afm, tax_office, street, street_number, city, postal_code)
values ('<registered name>', '<9-digit ΑΦΜ>', '<ΔΟΥ>', '<street>', '<no>', '<city>', '<postcode>');

update einvoice.settings set value = '"https://<business>.storeganise.com/api"' where key = 'sg_api_url';
update einvoice.settings set value = '"<business code>"' where key = 'sg_business_code';
```

Impact authentication (`impact_auth_mode`) needs only the company's API key in all three modes:

| Mode | How |
|---|---|
| `apikey` (default) | `APIKey: <key>` header on every call |
| `jwt` | `POST /Authentication/login` with `{ vat: "EL<ΑΦΜ>", key }` → 15-minute access token |
| `oauth2` | `POST /oauth/token`, `client_id = EL<ΑΦΜ>`, `client_secret = <key>` → 15-minute token |

For UAT, Impact's docs publish a demo company that always answers 408, which is useful
for testing retries: VAT `EL036712001`, API key `c0e4a18d-d3b4-40e6-92d0-ac96becb01c8`.

### 2. Deploy the service

Any Node 20+ host in the EU (Render, Fly.io, Heroku EU). There's a `Procfile`.
It needs one env var:

```
DATABASE_URL=<Supabase session pooler connection string, port 5432>
```

Then schedule the jobs against the deployed URL:

```sql
select einvoice.schedule_jobs('https://<your-host>');
```

### 3. Storeganise

- Create the custom fields.
  - **Invoice:** `ei_status`, `ei_doctype`, `ei_series`, `ei_number`, `ei_mark`, `ei_uid`,
    `ei_auth_code`, `ei_qr_url`, `ei_error`, `ei_sent_at`, `ei_credit_mark`.
  - **User:** `ei_is_business`, `ei_afm`, `ei_doy`, `ei_company_name`, and for business
    customers also `ei_address`, `ei_city`, `ei_postcode` (optionally `ei_country`, default GR).
    Storeganise keeps the customer address as one free-text line, and a B2B invoice needs the
    city and postcode as separate values.
- Create an API key: **Main Settings → Developer → API keys → +**, role **admin**. Save it in
  Vault as `sg_api_key`.
- Create the webhook: **Main Settings → Developer → Webhooks → +**, URL
  `https://<your-host>/webhook`, events `invoice.state.updated`,
  `invoice.payments.updated`, `invoice.deleted` (not `invoice.created`), plus at least one alert receiver email.
  The webhook secret is in `GET /api/v1/admin/settings`; save it in Vault as `sg_webhook_secret`.

### Local development

```bash
cp .env.example .env    # DATABASE_URL, plus INPROCESS_SCHEDULER=true and ALLOW_ENV_SECRETS=true
npm install
npm run dev
npm test                # runs on an in-memory Postgres (PGlite) with the real migrations
```

## Operator runbook (Supabase SQL editor)

| Need | SQL |
|---|---|
| What needs attention | `select * from einvoice.v_attention;` |
| Queue overview | `select * from einvoice.v_queue;` |
| Re-queue after fixing data in Storeganise | `select einvoice.requeue_job('<job id>', 'fixed postcode');` |
| Re-queue everything that gave up (e.g. after an outage) | `select einvoice.requeue_all(array['failed']);` |
| Re-read an invoice now | `select einvoice.refresh_invoice('<storeganise invoice id>');` |
| Pause / resume transmission | `select einvoice.set_paused(true);` / `select einvoice.set_paused(false);` |
| Series health / gaps | `select * from einvoice.v_series;` |
| Reconciliation findings | `select * from einvoice.v_open_reconciliation_issues;` |
| Full history for an invoice | `select * from einvoice.audit_log where sg_invoice_id = '<id>' order by at;` |
| Switch to production | `update einvoice.settings set value = '"production"' where key = 'impact_env';` |

Job statuses: `pending`, `sending`, `retry`, `sent`, `held` (customer tax data),
`failed_data` (validation / Impact 400), `failed` (retries exhausted), `skipped`
(not eligible, including "Not fully paid" if a payment was reversed before
sending; a later payment event re-checks it), `credited`. `impact_status` holds Impact's
own status (SUBMITTED / PENDING / INVALID) and `delayed_code` > 0 marks an
offline-issued document.

## Configuration (no deploy needed)

| Table | What |
|---|---|
| `einvoice.settings` | Environment, endpoints, auth mode, Storeganise states, retry policy, feature flags. Each row has a description. |
| `einvoice.doc_type_rules` | Customer kind × region × nature → myDATA type and series. |
| `einvoice.line_mappings` | Line type / accounting code → VAT category, exemption, income classification, exclusion. |
| `einvoice.payment_methods` | Storeganise payment method → myDATA payment code. |
| `einvoice.series` | Gapless counters. Set `next_number` before first use if continuing an existing series. |
| `einvoice.site_branches` | Optional branch code / series suffix per Storeganise site. |

**All seeded rules are placeholders (`approved = false`)** pending the accountant's
sign-off. In production (`impact_env = production`) the add-on refuses to send any
document that uses an unapproved row. Set `approved = true` on each row once the
accountant has signed it off.

## Showing the e-invoice to customers

Impact requires these on any rendered or printed copy of the document (Response
Examples & Error Handling → Mandatory Printing Fields). If the Storeganise invoice
template will show the e-invoice (FRD 9, pending), it needs:

- MARK (`ei_mark`), UID (`ei_uid`), authentication code (`ei_auth_code`)
- QR code of `ei_qr_url`
- Service provider name "Information systems IMPACT Μον. AE", URL www.einvoicing.gr,
  licence number 2023_10_103Impact_002_Impact eInvoicing_V1_24102023

The alternative is to let Impact deliver the legal document itself: set
`distribution_enabled` to true (TransmissionMethod `E`, sent to the customer's email).

### Offline issuance (optional, `offline_qr_enabled`, off by default)

When Impact is unreachable (5xx or network, IsDelayedCode 1), or Impact cannot reach
AADE (408, IsDelayedCode 2), the add-on can issue the document offline. It builds
Impact's signed offline QR (SHA-1 over the documented fields plus the API key),
writes it to `ei_qr_url` straight away, freezes the exact payload, and keeps
retrying it unchanged with `IsDelayedCode`. A printed copy must then also carry
the "Transmission Failure_1/2" notice. This only matters if customers must get a
legal document before transmission succeeds, so the accountant decides whether to
enable it.

## To confirm during UAT

Settled from Impact's docs (developers.s1ecos.com) and covered by tests: the
payload shape and field names, `DocumentTypeCode` "INVOICE" for credit notes too,
numeric `CorrelatedInvoices`, the SignatureResponse on 201/409 (numeric `mark`,
`url` = QR), the 400 body, the three auth flows, getdocuments on the portal host,
sign policies, TransmissionMethod, and the offline QR signature (matches Impact's
worked example).

Still to confirm:

- **Impact:** the `InvoiceType` text for 11.2 and 5.1. The samples only cover 1.1, 2.1,
  11.1, 11.4 and 5.2, so "Service Rendered Receipt" and "Credit Invoice Associated" are
  inferred.
- **Impact:** in the offline QR, whether `TotalAmount` is formatted as `12.4` or `12.40`
  for amounts with cents (Impact's example is a whole number).
- **Impact:** the getdocuments `To` parameter (the page shows both `To` and `dateTo`).
- **Storeganise:** confirmed from a real invoice (`test/fixtures/sg-invoice.json`): lines are
  `entries` (not `items`), each with its own `code`, `type`, `subtotal`, `taxPct`, `tax` and
  `total`, which the add-on uses as-is. Line mappings match on `code` (charge code, e.g. `rent`)
  and `type` (e.g. `revenue`). Still needed are sample invoices with:
  - a **discount/promotion**: is it a negative entry, and what `code`?
  - **insurance/protection** and **merchandise**: their `code` / `type`
  - a **deposit**: its `code` / `type`
  - a **refund**: the payment `type`
  - a **Storeganise credit note** (the invoice above has `meta.creditNote`): its JSON. Negative
    documents are held until this is known.
- **Storeganise:** that `PUT /v1/admin/invoices/:id` accepts `customFields` (the add-on
  merges in existing values so it can't wipe other fields), and that `include=customFields`
  returns them on invoices and users.
- **Accountant:** the document-type matrix, series codes, the VAT exemption code for
  insurance/protection (category 7 needs one of Impact's codes 1–31), income
  classifications, payment codes (card → 7 depends on POS linkage), deposit treatment, the
  credit-note policy (FR-COR-01), sign policy (STRICT vs DEFAULT) and offline issuance.

## Files

| Path | What |
|---|---|
| `server.js`, `main.js` | Express app; webhook signature check, business check, event routing (boilerplate) |
| `src/events/invoice-events.js` | Webhook handler: upserts the invoice's job |
| `src/storeganise-api.js` | Storeganise client: serial requests, custom-field write-back |
| `src/impact-api.js` | Impact client: auth modes, outcome classification, getdocuments |
| `src/mydata/*` | Normalisation, rules, mapper, validation, ΑΦΜ, money, credit notes, offline QR, error messages |
| `src/jobs/worker.js` | Claims jobs, renews leases, runs processors |
| `src/jobs/process-invoice.js` | Eligibility → numbering → transmission → post-issue checks |
| `src/jobs/process-credit.js` | Credit notes |
| `src/jobs/transmit.js` | Impact response policy and retry backoff |
| `src/jobs/writeback.js` | `ei_*` custom fields |
| `src/jobs/poll.js`, `reconcile.js` | Safety-net poll and nightly reconciliation |
| `src/jobs/scheduler.js` | `/jobs/*` endpoints for pg_cron, in-process timers for dev |
| `supabase/migrations` | Schema, functions, Vault/pg_cron, default (placeholder) configuration |
