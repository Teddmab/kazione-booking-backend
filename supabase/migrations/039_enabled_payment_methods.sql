-- 039_enabled_payment_methods.sql
--
-- Allows each business to control which payment methods are offered to
-- customers during online booking. An empty array means no online payment
-- step is shown and every booking is automatically confirmed as "pay at
-- venue" (equivalent to 'later').

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS enabled_payment_methods text[]
    NOT NULL DEFAULT '{deposit,full,later}'::text[]
    CONSTRAINT chk_enabled_payment_methods
      CHECK (
        enabled_payment_methods <@ ARRAY['deposit', 'full', 'later']::text[]
      );

COMMENT ON COLUMN business_settings.enabled_payment_methods IS
  'Payment methods shown to customers during booking. Empty = no online payment, auto-confirms as pay-at-venue.';
