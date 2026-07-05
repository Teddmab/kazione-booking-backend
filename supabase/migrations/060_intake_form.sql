-- Per-service intake form builder
-- Each service can define structured intake fields (label + type + options)
-- Client answers are stored as a JSON object keyed by field id

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS intake_form jsonb;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS intake_answers jsonb;
