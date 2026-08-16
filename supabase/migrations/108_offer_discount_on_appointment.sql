-- Migration 108: store computed offer discount on appointments
-- Mirrors entitlement_discount (added in 084) for the offers path.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS offer_discount NUMERIC;
