-- ─────────────────────────────────────────────────────────────────────────────
-- 016_businesses_extra_columns.sql
-- Add business_type, country, and owner_id columns that the frontend expects.
-- business_type mirrors the existing `industry` field for display purposes.
-- country is the ISO-3166 alpha-2 country code of the salon's location.
-- owner_id points to the user who registered the business.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS business_type  text,
  ADD COLUMN IF NOT EXISTS country        text NOT NULL DEFAULT 'EE',
  ADD COLUMN IF NOT EXISTS owner_id       uuid REFERENCES public.users(id) ON DELETE SET NULL;

-- Back-fill the seed business so the Settings page works in local dev
UPDATE businesses
SET
  business_type = 'afro_salon',
  country       = 'EE'
WHERE id = 'b0000000-0000-4000-8000-000000000001'
  AND business_type IS NULL;

-- Update setup_new_business to populate owner_id on registration
CREATE OR REPLACE FUNCTION setup_new_business(
  p_user_id       UUID,
  p_first_name    TEXT,
  p_email         TEXT,
  p_business_name TEXT,
  p_business_slug TEXT,
  p_last_name     TEXT    DEFAULT NULL,
  p_phone         TEXT    DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_business_id UUID;
BEGIN
  -- 1. Create user profile (mirrors auth.users)
  INSERT INTO users (id, email, first_name, last_name, phone)
  VALUES (p_user_id, p_email, p_first_name, p_last_name, p_phone);

  -- 2. Create business
  INSERT INTO businesses (name, slug, owner_id)
  VALUES (p_business_name, p_business_slug, p_user_id)
  RETURNING id INTO v_business_id;

  -- 3. Create owner membership (active immediately — no invite needed)
  INSERT INTO business_members (business_id, user_id, role, is_active, joined_at)
  VALUES (v_business_id, p_user_id, 'owner', true, now());

  -- 4. Create default business settings
  INSERT INTO business_settings (business_id)
  VALUES (v_business_id);

  RETURN v_business_id;
END;
$$;
