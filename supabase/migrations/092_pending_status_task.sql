-- 092_pending_status_task.sql
--
-- Adds a tracking column so the cron job can create a "please resolve this
-- appointment" task exactly once per overdue appointment, without relying on
-- a no-show auto-status change that could silently corrupt data.
--
-- pending_status_task_at: set to the timestamp when the owner+staff
-- "action required" notifications were created. NULL = task not yet sent.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS pending_status_task_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_appointments_pending_task
  ON appointments (business_id, pending_status_task_at)
  WHERE pending_status_task_at IS NULL AND status = 'confirmed';
