-- 064_staff_booking_visibility.sql
-- Owner toggle: let staff members see ALL appointments in the salon,
-- not just the ones assigned to them.
-- Default false (staff only see their own appointments).

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS staff_see_all_appointments boolean NOT NULL DEFAULT false;
