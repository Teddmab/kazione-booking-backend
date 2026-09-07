-- Surfaces "OÜ" in the Obligations tab's profile strip. Nullable, no CHECK —
-- kept generically extensible beyond Estonia, same spirit as businesses.country
-- having no enum either.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS legal_form text;

UPDATE businesses SET legal_form = 'OÜ' WHERE id = 'b0000000-0000-4000-8000-000000000001';
