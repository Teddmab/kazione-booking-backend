-- 172_tax_obligation_profile_fields.sql
-- Fields the redesigned Obligations tab's profile strip and "Responsible"
-- rows need that tax_profile didn't have yet: whether the business employs
-- staff, a lightweight (non-login) accountant identity, the VAT
-- registration effective date, and a per-obligation-type responsible party.
-- No accountant login/role exists — "accountant" here is just a name/email
-- pair the owner records, not a real second-party account.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS employs_staff       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS accountant_name     text,
  ADD COLUMN IF NOT EXISTS accountant_email    text,
  ADD COLUMN IF NOT EXISTS vat_registration_date date,
  ADD COLUMN IF NOT EXISTS vat_responsible     text NOT NULL DEFAULT 'owner' CHECK (vat_responsible IN ('owner', 'accountant')),
  ADD COLUMN IF NOT EXISTS tsd_responsible     text NOT NULL DEFAULT 'owner' CHECK (tsd_responsible IN ('owner', 'accountant')),
  ADD COLUMN IF NOT EXISTS annual_responsible  text NOT NULL DEFAULT 'owner' CHECK (annual_responsible IN ('owner', 'accountant'));
