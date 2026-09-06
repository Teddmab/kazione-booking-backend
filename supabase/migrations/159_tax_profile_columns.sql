-- Persists the tax profile fields that CountryTaxConfig.tsx's "Save Tax
-- Configuration" button has never actually saved anywhere. Country reuses
-- the existing businesses.country column — no new field for that.
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS vat_registered boolean,
  ADD COLUMN IF NOT EXISTS vat_number text,
  ADD COLUMN IF NOT EXISTS tax_reporting_frequency text DEFAULT 'quarterly',
  ADD COLUMN IF NOT EXISTS tax_profile_confirmed_at timestamptz;
