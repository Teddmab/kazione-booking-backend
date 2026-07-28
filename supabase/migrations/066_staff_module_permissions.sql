-- Add staff_module_permissions to business_settings
-- Stores which nav modules are enabled for staff members as a JSONB map of { [moduleKey]: boolean }
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS staff_module_permissions JSONB DEFAULT '{}'::JSONB;
