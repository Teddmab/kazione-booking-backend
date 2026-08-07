-- 093_training_i18n.sql
--
-- Adds JSONB i18n columns to all three training tables so AI-generated
-- courses can be stored in all 4 supported locales (en, et, fr, ru) at once.
--
-- Shape: { "en": "...", "et": "...", "fr": "...", "ru": "..." }
-- The main text column (title, description, content_text) remains the English
-- fallback; _i18n columns carry all locales and take priority in the player.

ALTER TABLE training_courses
  ADD COLUMN IF NOT EXISTS title_i18n       jsonb,
  ADD COLUMN IF NOT EXISTS description_i18n jsonb;

ALTER TABLE training_chapters
  ADD COLUMN IF NOT EXISTS title_i18n       jsonb;

ALTER TABLE training_sections
  ADD COLUMN IF NOT EXISTS title_i18n        jsonb,
  ADD COLUMN IF NOT EXISTS content_text_i18n jsonb;
