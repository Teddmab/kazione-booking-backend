-- ─────────────────────────────────────────────────────────────────────────────
-- 028_fix_setup_new_business_overload.sql
--
-- Migration 026 accidentally created a second overload of setup_new_business
-- (9 params) instead of replacing the 7-param version from 025. PostgreSQL
-- cannot resolve the call when named params match both signatures, causing a
-- 500 on POST /create-business.
--
-- Additionally, the 026 version dropped the storefront INSERT that 025 added.
--
-- Fix:
--   1. Drop the old 7-param overload.
--   2. Replace the 9-param overload with the canonical version that includes
--      the storefront INSERT (step 5).
-- ─────────────────────────────────────────────────────────────────────────────

-- Drop the old 7-param overload (signature from 025).
DROP FUNCTION IF EXISTS setup_new_business(
  UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
);

-- Canonical version: 9 params (country + business_type with defaults) AND
-- storefront auto-creation on step 5.
CREATE OR REPLACE FUNCTION setup_new_business(
  p_user_id       UUID,
  p_first_name    TEXT,
  p_email         TEXT,
  p_business_name TEXT,
  p_business_slug TEXT,
  p_last_name     TEXT    DEFAULT NULL,
  p_phone         TEXT    DEFAULT NULL,
  p_country       TEXT    DEFAULT 'EE',
  p_business_type TEXT    DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_business_id UUID;
BEGIN
  -- 1. Upsert user profile
  INSERT INTO users (id, email, first_name, last_name, phone)
  VALUES (p_user_id, p_email, p_first_name, p_last_name, p_phone)
  ON CONFLICT (id) DO UPDATE
    SET first_name = EXCLUDED.first_name,
        last_name  = EXCLUDED.last_name,
        phone      = EXCLUDED.phone;

  -- 2. Create business
  INSERT INTO businesses (name, slug, owner_id, country, business_type)
  VALUES (p_business_name, p_business_slug, p_user_id, p_country, p_business_type)
  RETURNING id INTO v_business_id;

  -- 3. Create owner membership
  INSERT INTO business_members (business_id, user_id, role, is_active, joined_at)
  VALUES (v_business_id, p_user_id, 'owner', true, now());

  -- 4. Create default business settings
  INSERT INTO business_settings (business_id)
  VALUES (v_business_id);

  -- 5. Auto-create a draft storefront so the Storefront Editor has a row.
  INSERT INTO storefronts (business_id, slug, title)
  VALUES (v_business_id, p_business_slug, p_business_name);

  RETURN v_business_id;
END;
$$;
