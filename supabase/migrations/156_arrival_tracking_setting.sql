-- 156_arrival_tracking_setting.sql
-- Owner toggle: turn on the Prepare→Arrival→Service→Complete stepper for
-- staff. Off by default — staff keep today's confirmed→in_progress flow
-- until an owner opts in.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS enable_arrival_tracking boolean NOT NULL DEFAULT false;
