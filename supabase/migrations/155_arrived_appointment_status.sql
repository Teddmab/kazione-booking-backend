-- 155_arrived_appointment_status.sql
-- Add 'arrived' to the appointment_status enum — the client has physically
-- checked in but the service hasn't started yet (staff-facing arrival
-- tracking, gated per-business by business_settings.enable_arrival_tracking).
--
-- Status lifecycle extension:
--   confirmed → arrived → in_progress → pending_completion → completed
--   (arrived is skippable: confirmed → in_progress still works when the
--   business has arrival tracking off, exactly as today)
--
-- Note: ALTER TYPE ADD VALUE cannot run inside a transaction in PG < 12.
-- Supabase runs PG 15+, so this is safe. Using IF NOT EXISTS for idempotency.

ALTER TYPE appointment_status ADD VALUE IF NOT EXISTS 'arrived';
