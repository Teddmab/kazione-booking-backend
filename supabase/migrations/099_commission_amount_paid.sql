-- Migration 099: store the actual amount paid for commission
-- Allows owners to override the computed commission before marking paid.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS commission_amount_paid numeric;
