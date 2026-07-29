-- 077_offered_appointment_status.sql
-- Add 'offered' status to the appointment_status enum.
--
-- Lifecycle:
--   pending   → created, no staff assigned (online booking without referral)
--   offered   → staff assigned and awaiting their confirmation
--               (referral auto-assign OR owner manually assigns a staff member)
--   confirmed → staff accepted the appointment
--   in_progress / completed / cancelled / no_show → unchanged
--
-- Note: ALTER TYPE ADD VALUE cannot run inside a transaction in PG < 12.
-- Supabase runs PG 15+, so this is safe. Using IF NOT EXISTS for idempotency.

ALTER TYPE appointment_status ADD VALUE IF NOT EXISTS 'offered';
