-- 076_intake_answers_jsonb.sql
-- Add intake_answers (jsonb) column to appointments.
--
-- The existing intake_answer (text) column was a single legacy field.
-- intake_answers stores a structured map of all intake form fields:
--   { [field_id]: { label: string, value: string | boolean | ... } }
--
-- The create-booking Edge Function populates this when the storefront
-- has a multi-field intake form configured on the booked service.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS intake_answers jsonb;

COMMENT ON COLUMN appointments.intake_answers IS
  'Structured intake form answers: { [field_id]: { label, value } }';
