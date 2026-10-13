-- FRD v1.3 (scope §2, FR-CAP-01/03/05): an unpaid invoice is a pro forma. No job is
-- created and nothing is sent to Impact until the invoice is fully paid, for every
-- document type. The per-rule trigger (B2B on issue, B2C on payment) is gone.

alter table einvoice.doc_type_rules drop column trigger;

-- "Issued" no longer decides anything; "fully paid" does (see rules.isFullyPaid).
delete from einvoice.settings where key = 'sg_issued_states';

update einvoice.settings
   set description = 'Invoice states that count as fully paid. Otherwise balance <= 0 with a positive total does (FR-CAP-03).'
 where key = 'sg_paid_states';
