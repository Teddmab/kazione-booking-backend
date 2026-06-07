-- 047_business_payment_settings.sql
--
-- Adds per-business payment gateway toggles to business_settings.
-- Platform admins can enable/disable Stripe and PawaPay per business
-- from the admin portal. Cash is always controlled by accept_cash (existing).
--
-- SECURITY: toggling is admin-only via service-role edge functions.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS stripe_enabled  boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pawapay_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN business_settings.stripe_enabled  IS 'Platform admin toggle — can this business accept Stripe payments?';
COMMENT ON COLUMN business_settings.pawapay_enabled IS 'Platform admin toggle — can this business accept PawaPay (mobile money)?';
