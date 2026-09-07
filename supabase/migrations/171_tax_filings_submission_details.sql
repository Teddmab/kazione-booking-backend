-- 171_tax_filings_submission_details.sql
-- Extends tax_filings (previously just a flat filed_at/filed_by log) with
-- the details captured on the VAT wizard's Export & submit step, plus a
-- payment-recording follow-up. All additive and nullable — existing rows
-- (and existing POST ?action=tax-filings callers that only send period/
-- obligation_type) are unaffected.

ALTER TABLE tax_filings
  ADD COLUMN IF NOT EXISTS submission_date        date,
  ADD COLUMN IF NOT EXISTS submitted_by_name      text,
  ADD COLUMN IF NOT EXISTS authority_reference    text,
  ADD COLUMN IF NOT EXISTS declared_amount        numeric(10,2),
  ADD COLUMN IF NOT EXISTS payment_due_date       date,
  ADD COLUMN IF NOT EXISTS confirmation_receipt_id uuid REFERENCES receipts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_amount         numeric(10,2),
  ADD COLUMN IF NOT EXISTS payment_date           date,
  ADD COLUMN IF NOT EXISTS payment_reference      text,
  ADD COLUMN IF NOT EXISTS payment_recorded_at    timestamptz;
