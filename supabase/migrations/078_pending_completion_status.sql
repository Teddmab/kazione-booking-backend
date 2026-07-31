-- 078_pending_completion_status.sql
-- Add 'pending_completion' to the appointment_status enum.
--
-- Status lifecycle extension:
--   confirmed / in_progress → pending_completion (staff marks done + submits payment method)
--   pending_completion      → completed          (owner confirms)
--   pending_completion      → confirmed          (owner rejects completion — edge case)

ALTER TYPE appointment_status ADD VALUE IF NOT EXISTS 'pending_completion';
