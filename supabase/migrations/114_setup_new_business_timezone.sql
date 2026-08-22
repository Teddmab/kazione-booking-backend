-- ─────────────────────────────────────────────────────────────────────────────
-- 114 — setup_new_business accepts a timezone (S59)
--
-- setup_new_business (canonical version: 028_fix_setup_new_business_overload.sql)
-- never set businesses.timezone, so every new business — regardless of
-- p_country — silently got the column's 'Europe/Tallinn' default. Add an
-- optional p_timezone param (defaulting to the same 'Europe/Tallinn', so
-- existing callers that don't pass it are unaffected) and set it explicitly
-- on the businesses INSERT.
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
  p_business_type TEXT    DEFAULT NULL,
  p_timezone      TEXT    DEFAULT 'Europe/Tallinn'
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
  INSERT INTO businesses (name, slug, owner_id, country, business_type, timezone)
  VALUES (p_business_name, p_business_slug, p_user_id, p_country, p_business_type,
          COALESCE(p_timezone, 'Europe/Tallinn'))
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
