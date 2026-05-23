-- ─────────────────────────────────────────────────────────────────────────────
-- 026_setup_business_country_type.sql
-- Extend setup_new_business RPC to accept country and business_type at signup.
-- Both columns already exist on the businesses table (migration 016).
-- ─────────────────────────────────────────────────────────────────────────────

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

  -- 2. Create business with country and type provided at signup
  INSERT INTO businesses (name, slug, owner_id, country, business_type)
  VALUES (p_business_name, p_business_slug, p_user_id, p_country, p_business_type)
  RETURNING id INTO v_business_id;

  -- 3. Create owner membership
  INSERT INTO business_members (business_id, user_id, role, is_active, joined_at)
  VALUES (v_business_id, p_user_id, 'owner', true, now());

  -- 4. Create default business settings
  INSERT INTO business_settings (business_id)
  VALUES (v_business_id);

  RETURN v_business_id;
END;
$$;
