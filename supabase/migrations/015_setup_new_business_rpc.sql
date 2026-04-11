-- ─────────────────────────────────────────────────────────────────────────────
-- 015_setup_new_business_rpc.sql
-- Atomic registration: user profile + business + owner membership + settings
-- Called from the auth-register Edge Function; runs in a single transaction.
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
  -- 1. Create user profile (mirrors auth.users)
  INSERT INTO users (id, email, first_name, last_name, phone)
  VALUES (p_user_id, p_email, p_first_name, p_last_name, p_phone);

  -- 2. Create business
  INSERT INTO businesses (name, slug)
  VALUES (p_business_name, p_business_slug)
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
