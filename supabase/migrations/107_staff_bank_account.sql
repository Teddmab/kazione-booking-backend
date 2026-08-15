-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 107 — Staff bank account details for commission payments
--
-- Stores the bank account a staff member provides for receiving commissions.
-- ee_accepted_at: when the staff member acknowledged the Estonian entrepreneur-
-- account requirement (FIE/OÜ business account, not a personal account).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE staff_profiles
  ADD COLUMN IF NOT EXISTS bank_account_iban            text,
  ADD COLUMN IF NOT EXISTS bank_account_bank_name       text,
  ADD COLUMN IF NOT EXISTS bank_account_holder_name     text,
  ADD COLUMN IF NOT EXISTS bank_account_is_entrepreneur boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bank_account_ee_accepted_at  timestamptz;
