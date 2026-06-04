-- 039_service_buffer_minutes.sql
-- Adds per-service buffer time: a cleanup/preparation window appended after
-- the appointment end that blocks the staff member for the next slot.
-- Buffer is stored on the service (not the appointment) so it can be changed
-- without rewriting historical data.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS buffer_minutes INT NOT NULL DEFAULT 0
    CHECK (buffer_minutes >= 0 AND buffer_minutes <= 120);

COMMENT ON COLUMN services.buffer_minutes IS
  'Cleanup/prep minutes added after service end. Blocks the next slot for the staff member.';
