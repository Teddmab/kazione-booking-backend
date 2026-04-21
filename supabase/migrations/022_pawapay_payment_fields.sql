-- ─────────────────────────────────────────────────────────────────────────────
-- 022_pawapay_payment_fields.sql
-- Adds mobile_money to payment_method enum and Pawapay-specific columns to payments
-- ─────────────────────────────────────────────────────────────────────────────
-- Add 'mobile_money' to the payment_method enum if it doesn't exist yet
DO $$ BEGIN ALTER TYPE payment_method
ADD VALUE IF NOT EXISTS 'mobile_money';
EXCEPTION
WHEN others THEN NULL;
END $$;
-- Add provider column (e.g. 'stripe', 'pawapay') to payments table
ALTER TABLE payments
ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_deposit_id text UNIQUE;
COMMENT ON COLUMN payments.provider IS 'Payment provider: stripe, pawapay, etc.';
COMMENT ON COLUMN payments.provider_deposit_id IS 'Provider-specific deposit/transaction ID (e.g. Pawapay depositId)';
