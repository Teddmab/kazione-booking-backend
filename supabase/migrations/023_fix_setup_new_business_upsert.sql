-- ─────────────────────────────────────────────────────────────────────────────
-- 023_fix_setup_new_business_upsert.sql
--
-- The on_auth_user_created trigger (001_enums.sql) fires as soon as
-- supabaseAdmin.auth.admin.createUser() is called, pre-inserting a row into
-- public.users. setup_new_business then attempted a plain INSERT on the same
-- primary key, causing a unique-violation that rolled back the whole RPC.
--
-- Fix: change the users INSERT to ON CONFLICT DO UPDATE so the RPC overwrites
-- the trigger's empty first_name/last_name with the values from the signup form.
-- ─────────────────────────────────────────────────────────────────────────────

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
  -- 1. Upsert user profile — the on_auth_user_created trigger may have already
  --    inserted a bare row; this overwrites it with the full registration data.
  INSERT INTO users (id, email, first_name, last_name, phone)
  VALUES (p_user_id, p_email, p_first_name, p_last_name, p_phone)
  ON CONFLICT (id) DO UPDATE
    SET first_name = EXCLUDED.first_name,
        last_name  = EXCLUDED.last_name,
        phone      = EXCLUDED.phone;

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
