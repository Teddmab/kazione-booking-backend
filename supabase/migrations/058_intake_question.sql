-- 058 — per-business intake question for storefront booking flow
-- Owner sets one optional question; clients answer it during booking.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS intake_question text;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS intake_answer text;

COMMENT ON COLUMN business_settings.intake_question IS 'Optional custom question shown to clients during online booking (e.g. "Do you have any allergies?")';
COMMENT ON COLUMN appointments.intake_answer          IS 'Client''s answer to the business intake question at time of booking';
