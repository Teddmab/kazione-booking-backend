-- Global intake form (one form definition shared across all services)
-- Replaces per-service intake_form with a business-level definition
-- Per-service opt-in via use_intake_form boolean

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS intake_form jsonb;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS use_intake_form boolean NOT NULL DEFAULT false;

-- Drop the per-service intake_form added in 060 (was empty, redesigned to global)
ALTER TABLE services
  DROP COLUMN IF EXISTS intake_form;
