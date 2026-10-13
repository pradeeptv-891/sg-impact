-- Default configuration.
--
-- IMPORTANT: every document-type rule, line mapping and payment-method row below
-- is a PLACEHOLDER (approved = false) pending the Client's accountant sign-off
-- (FRD 3.1 / 11.1). The service refuses to transmit in production while any row
-- it uses is unapproved; see the `require_approved_mapping` setting.
--
-- The issuer (einvoice.issuer) is deliberately NOT seeded: the service holds every
-- job until it is configured.

insert into einvoice.settings (key, value, description) values
  -- Environment (FR-CFG-01). Hosts and paths per developers.s1ecos.com.
  ('impact_env',                   '"uat"', 'uat | production. Selects base URLs and Vault secret names.'),
  ('impact_base_url_uat',          '"https://einvoiceapiuat.impact.gr"', 'Impact API base URL (UAT)'),
  ('impact_base_url_production',   '"https://einvoiceapi.impact.gr"', 'Impact API base URL (production)'),
  ('impact_portal_url_uat',        '"https://einvoiceportaluat.impact.gr"', 'Impact portal (UAT): getdocuments and offline QR'),
  ('impact_portal_url_production', '"https://einvoice.impact.gr"', 'Impact portal (production): getdocuments and offline QR'),
  ('impact_send_path',             '"/invoice/json"', 'POST path for documents'),
  ('impact_getdocuments_path',     '"/api/invoice/getdocuments/{vat}/{page}/"', 'GET path for document retrieval (on the portal host)'),
  ('impact_auth_mode',             '"apikey"', 'apikey (APIKey header) | jwt (/Authentication/login) | oauth2 (/oauth/token). All use the same API key.'),
  ('impact_apikey_header',         '"APIKey"', 'Header carrying the API key when impact_auth_mode = apikey'),
  ('impact_token_url',             'null', 'Override for the jwt / oauth2 token URL. null = <base>/Authentication/login or <base>/oauth/token.'),
  ('impact_timeout_ms',            '30000', 'Timeout for Impact calls'),
  ('impact_sign_policy',           '2', 'IAPRSignPolicy. 2 STRICT: AADE timeout → 408, not stored (we retry). 0 DEFAULT: stored, 201 PENDING, MARK followed up.'),

  -- Storeganise
  ('sg_api_url',                   'null', 'e.g. https://<business>.storeganise.com/api'),
  ('sg_business_code',             'null', 'Webhooks from any other business are rejected'),
  ('sg_timeout_ms',                '20000', 'Timeout for Storeganise calls'),
  ('sg_issued_states',             '["sent", "paid", "failed"]', 'Invoice states that count as issued (FR-CAP-03)'),
  ('sg_paid_states',               '["paid"]', 'Invoice states that count as paid (FR-CAP-05 on_payment trigger)'),
  ('sg_void_states',               '["writtenOff", "cancelled", "void", "voided"]', 'States that reverse an invoice (FR-COR-01)'),
  ('sg_discount_line_types',       '["discount", "promo", "promotion", "coupon"]', 'Line types treated as discounts (FR-MAP-04)'),
  ('sg_refund_payment_types',      '["refund"]', 'Payment types treated as refunds (FR-COR-02)'),
  ('prices_include_tax',           'false', 'true if Storeganise line prices are VAT-inclusive'),

  -- Mapping behaviour
  ('discount_mode',                '"allocate"', 'allocate: spread discounts across lines of the same VAT rate. reject: hold the invoice.'),
  ('mixed_nature',                 '"services"', 'Nature used for document-type selection when an invoice has goods and services lines'),
  ('zero_value_policy',            '"skip"', 'skip | send. Zero-total invoices (FR-CAP-03)'),
  ('require_approved_mapping',     'true', 'Refuse production transmission using unapproved mapping rows'),
  ('distribution_enabled',         'false', 'FR-TX-06: Impact emails the document to the customer (TransmissionMethod E). Off = archive only (A).'),
  ('offline_qr_enabled',           'false', 'Issue with Impact offline QR + IsDelayedCode when Impact/AADE is unreachable. Accountant to confirm.'),
  ('mark_followup_minutes',        '15', 'How often a sent document still waiting for its MARK is looked up'),

  -- Corrections (FR-COR-01 is TBC with the Client, so off by default)
  ('credit_notes_enabled',         'false', 'Issue a full credit note when a sent invoice is voided/deleted'),
  ('partial_credit_enabled',       'false', 'Issue a partial credit note on refunds'),

  -- Worker & retries (FR-TX-04)
  ('transmission_paused',          'false', 'Kill switch (FR-CFG-05). Use einvoice.set_paused().'),
  ('worker_batch_size',            '25', 'Jobs per worker run'),
  ('worker_lease_seconds',         '300', 'How long a claimed job stays locked'),
  ('retry_max_attempts',           '8', 'Transmission attempts before a job is marked failed'),
  ('retry_base_seconds',           '340', 'Backoff base; 8 attempts ≈ 24h'),
  ('retry_max_delay_seconds',      '21600', 'Cap on one backoff step'),

  -- Poll & reconciliation (FR-CAP-04, FR-REC-01)
  ('poll_overlap_seconds',         '300', 'Overlap between safety-net poll windows'),
  ('poll_page_size',               '100', 'Invoices per Storeganise list page'),
  ('reconcile_lookback_days',      '3', 'Window checked by the nightly reconciliation'),
  ('reconcile_stale_minutes',      '60', 'Eligible jobs older than this that are not sent are reported'),

  -- Logging (FR-ERR-01)
  ('audit_retention_days',         'null', 'Days to keep the audit log. null = keep forever (accountant to advise).')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Series (FR-CFG-04). Codes are placeholders; confirm with the accountant.
-- ---------------------------------------------------------------------------
insert into einvoice.series (code, description) values
  ('TPY',  'Τιμολόγιο Παροχής Υπηρεσιών (2.1) — B2B services'),
  ('TP',   'Τιμολόγιο Πώλησης (1.1) — B2B goods'),
  ('APY',  'Απόδειξη Παροχής Υπηρεσιών (11.2) — B2C services'),
  ('ALP',  'Απόδειξη Λιανικής Πώλησης (11.1) — B2C goods'),
  ('PT',   'Πιστωτικό Τιμολόγιο Συσχετιζόμενο (5.1) — B2B credit'),
  ('PSL',  'Πιστωτικό Στοιχείο Λιανικής (11.4) — B2C credit')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Document-type rules (FR-MAP-01, FR-CAP-05). PLACEHOLDERS.
-- Only Greek B2B counterparties are covered; EU / non-EU business customers are
-- held until the accountant supplies rules (e.g. 2.2 / 2.3).
-- DocumentTypeCode is "INVOICE" for every fiscal document sent to AADE, credit
-- notes included (Impact: Document Type Codes).
-- ---------------------------------------------------------------------------
insert into einvoice.doc_type_rules
  (kind, customer_kind, region, nature, invoice_type_code, invoice_type_name, document_type_code, series_code, trigger, priority, notes)
values
  ('invoice', 'b2b', 'GR', 'services', '2.1',  'Service Rendered Invoice',  'INVOICE', 'TPY', 'on_issue',   10, 'Placeholder. Name per Impact sample.'),
  ('invoice', 'b2b', 'GR', 'mixed',    '2.1',  'Service Rendered Invoice',  'INVOICE', 'TPY', 'on_issue',   10, 'Placeholder: mixed treated as services'),
  ('invoice', 'b2b', 'GR', 'goods',    '1.1',  'Sales Invoice',             'INVOICE', 'TP',  'on_issue',   10, 'Placeholder. Name per Impact sample.'),
  ('invoice', 'b2c', null, 'services', '11.2', 'Service Rendered Receipt',  'INVOICE', 'APY', 'on_payment', 10, 'Placeholder. Name not in Impact samples; confirm.'),
  ('invoice', 'b2c', null, 'mixed',    '11.2', 'Service Rendered Receipt',  'INVOICE', 'APY', 'on_payment', 10, 'Placeholder. Name not in Impact samples; confirm.'),
  ('invoice', 'b2c', null, 'goods',    '11.1', 'Retail Sales Receipt',      'INVOICE', 'ALP', 'on_payment', 10, 'Placeholder. Name per Impact sample.'),
  ('credit',  'b2b', null, null,       '5.1',  'Credit Invoice Associated', 'INVOICE', 'PT',  'on_issue',   10, 'Placeholder. Name inferred from the 5.2 sample; confirm.'),
  ('credit',  'b2c', null, null,       '11.4', 'Retail Sales Credit Note',  'INVOICE', 'PSL', 'on_issue',   10, 'Placeholder. Name per Impact sample.');

-- ---------------------------------------------------------------------------
-- Line mappings (FR-CFG-03). PLACEHOLDERS.
-- E3_561_001 = sales of goods/services to businesses; E3_561_003 = retail (private
-- customers). category1_3 = services revenue; category1_1 = goods revenue.
-- ---------------------------------------------------------------------------
insert into einvoice.line_mappings
  (customer_kind, line_type, accounting_code, priority, exclude, nature, vat_category_code, vat_exemption_code,
   classification_type_code, classification_category_code, notes)
values
  -- Matched on the Storeganise invoice entry: accounting_code = entry.code (the
  -- charge code, e.g. "rent"), line_type = entry.type (e.g. "revenue").
  ('b2b', null,      null,        1000, false, 'services', null, null, 'E3_561_001', 'category1_3', 'Fallback: B2B services (rent and other charges)'),
  ('b2c', null,      null,        1000, false, 'services', null, null, 'E3_561_003', 'category1_3', 'Fallback: B2C services (rent and other charges)'),
  (null,  null,      'deposit',   100,  true,  'services', null, null, null,          'category1_3', 'Security deposit held, not revenue (FRD 3.1)'),
  (null,  'deposit', null,        100,  true,  'services', null, null, null,          'category1_3', 'Security deposit held, not revenue (FRD 3.1)'),
  ('b2b', null,      'insurance', 100,  false, 'services', 7,    null, 'E3_561_001', 'category1_3', 'Insurance/protection: accountant to confirm VAT exemption code (1–31)'),
  ('b2c', null,      'insurance', 100,  false, 'services', 7,    null, 'E3_561_003', 'category1_3', 'Insurance/protection: accountant to confirm VAT exemption code (1–31)'),
  ('b2b', 'product', null,        100,  false, 'goods',    null, null, 'E3_561_001', 'category1_1', 'Merchandise (locks, boxes): confirm the entry type / codes Storeganise uses'),
  ('b2c', 'product', null,        100,  false, 'goods',    null, null, 'E3_561_003', 'category1_1', 'Merchandise (locks, boxes): confirm the entry type / codes Storeganise uses');

-- ---------------------------------------------------------------------------
-- Payment methods (FR-MAP-06). PLACEHOLDERS.
-- myDATA codes: 1 domestic payment account, 2 foreign payment account, 3 cash,
-- 4 cheque, 5 on credit, 6 web banking, 7 POS / e-POS, 8 IRIS.
-- ---------------------------------------------------------------------------
insert into einvoice.payment_methods (sg_method, mydata_code, mydata_name, notes) values
  ('*',             5, 'Επί Πιστώσει',               'Fallback, and unpaid B2B invoices'),
  ('oncredit',      5, 'Επί Πιστώσει',               null),
  ('cash',          3, 'Μετρητά',                    null),
  ('cheque',        4, 'Επιταγή',                    'Seen in Storeganise as payment method "cheque"'),
  ('check',         4, 'Επιταγή',                    null),
  ('bank',          1, 'Επαγ. Λογαριασμός Πληρωμών Ημεδαπής', null),
  ('banktransfer',  1, 'Επαγ. Λογαριασμός Πληρωμών Ημεδαπής', null),
  ('card',          7, 'POS / e-POS',                'POS linkage rules pending accountant (FRD 9)'),
  ('stripe',        7, 'POS / e-POS',                'POS linkage rules pending accountant (FRD 9)'),
  ('gocardless',    1, 'Επαγ. Λογαριασμός Πληρωμών Ημεδαπής', 'Direct debit')
on conflict (sg_method) do nothing;
