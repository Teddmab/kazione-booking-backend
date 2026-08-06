-- Track how many completion reminder emails have been sent for overdue appointments
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS completion_reminder_count   INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completion_reminder_last_sent_at TIMESTAMPTZ;
