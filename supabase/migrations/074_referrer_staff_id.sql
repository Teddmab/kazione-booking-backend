-- ---------------------------------------------------------------------------
-- 074_referrer_staff_id.sql
-- Add referrer_staff_id to appointments for the Staff Referral System (S17).
--
-- When a client visits the storefront via a referral link
-- (/client/salon/<slug>?ref=<staff_profile_id>), the booking flow captures
-- that staff_profile_id and stores it here so referral stats can be queried.
-- ---------------------------------------------------------------------------

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS referrer_staff_id uuid
  REFERENCES staff_profiles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_referrer_staff_id
  ON appointments (referrer_staff_id)
  WHERE referrer_staff_id IS NOT NULL;
