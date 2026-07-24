-- 067_service_auto_show_staff.sql
-- Per-service toggle: when true (default), new bookings for this service are
-- automatically visible to staff members (they can see the booking in their queue).
-- When false, bookings sit in the owner queue until manually assigned.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS auto_show_to_staff boolean NOT NULL DEFAULT true;
