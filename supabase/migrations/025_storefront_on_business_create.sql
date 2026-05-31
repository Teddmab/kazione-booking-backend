-- ─────────────────────────────────────────────────────────────────────────────
-- 025_storefront_on_business_create.sql
--
-- When a new business is created via setup_new_business, no storefront row was
-- being inserted. This caused two problems:
--   1. The Storefront Editor had nothing to load / edit.
--   2. The new business could never appear on the marketplace.
--
-- Fix: add step 5 to setup_new_business — auto-create a draft storefront row
-- using the business slug and name. The owner must still publish it via the
-- Storefront Editor + set marketplace_status to 'active' to go live.
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
  -- 1. Upsert user profile
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

  -- 5. Create a draft storefront so the Storefront Editor has a row to work with.
  --    is_published = false and marketplace_status = 'draft' by default — the
  --    owner must publish explicitly via the Storefront Editor.
  INSERT INTO storefronts (business_id, slug, title)
  VALUES (v_business_id, p_business_slug, p_business_name);

  RETURN v_business_id;
END;
$$;
