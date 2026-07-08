-- Add auto-translate flag and per-locale translations cache to business_settings
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS translate_booking_terms boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS booking_terms_translations jsonb;
