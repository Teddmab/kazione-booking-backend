-- ─────────────────────────────────────────────────────────────────────────────
-- Staff supervisor role
--
-- A supervisor is a staff member who:
--   - Receives all booking notifications for the business (replacing the old
--     fixed business_settings.booking_notification_email / dead
--     notify_new_booking toggle — see _shared/bookingNotificationRecipients.ts)
--   - Can reassign any appointment that isn't already completed (not just
--     ones assigned to them)
--   - Can mark any appointment completed, even one assigned to a different
--     staff member
--
-- Multiple supervisors are allowed per business (independent per-staff flag).
-- business_settings.booking_notification_email / notify_new_booking are left
-- in place (not dropped) — existing data isn't destroyed, they're just no
-- longer read by the notification code or exposed in Settings.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE staff_profiles
  ADD COLUMN is_supervisor boolean NOT NULL DEFAULT false;

CREATE INDEX idx_staff_profiles_supervisor
  ON staff_profiles (business_id, is_supervisor)
  WHERE is_supervisor = true;
