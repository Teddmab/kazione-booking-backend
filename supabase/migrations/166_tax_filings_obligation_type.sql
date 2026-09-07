-- tax_filings previously only supported one filing per literal period string,
-- so VAT return / income & social tax (TSD) / annual report couldn't coexist
-- as independently-trackable obligations for the same calendar period.
-- Existing rows are backfilled as 'vat_return' — that's what every filing
-- recorded so far actually was.
ALTER TABLE tax_filings ADD COLUMN IF NOT EXISTS obligation_type text NOT NULL DEFAULT 'vat_return';

ALTER TABLE tax_filings ADD CONSTRAINT tax_filings_obligation_type_check
  CHECK (obligation_type IN ('vat_return', 'income_social_tax', 'annual_report'));

ALTER TABLE tax_filings DROP CONSTRAINT tax_filings_business_id_period_key;
ALTER TABLE tax_filings ADD CONSTRAINT tax_filings_business_id_period_obligation_type_key
  UNIQUE (business_id, period, obligation_type);
