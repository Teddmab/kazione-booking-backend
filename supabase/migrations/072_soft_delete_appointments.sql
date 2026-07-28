-- S13: Soft delete for cancelled appointments.
-- Deleted records remain in DB for audit; queries filter them via deleted_at IS NULL.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_appointments_not_deleted
  ON appointments(business_id, starts_at)
  WHERE deleted_at IS NULL;
