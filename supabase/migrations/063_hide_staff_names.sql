-- 063_hide_staff_names.sql
-- Global toggle: hide staff names from the client-facing booking flow.
-- When true, staff appear as "Professional" on the storefront and
-- in availability slots. Staff IDs are preserved for booking logic.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS hide_staff_names boolean NOT NULL DEFAULT false;
