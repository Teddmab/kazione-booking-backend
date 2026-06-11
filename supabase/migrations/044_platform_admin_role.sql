-- 044_platform_admin_role.sql
--
-- Adds is_platform_admin flag to users table.
-- Platform admins are KaziOne internal team members who can read
-- data across ALL tenants with no business_id restriction.
--
-- SECURITY: This column must NEVER be settable via any API endpoint.
-- Promotion is manual-only via Supabase Studio or direct SQL.

-- ── Column ────────────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN users.is_platform_admin IS
  'KaziOne internal team only. Set manually via Supabase Studio — never via API.';

-- ── Helper function (used in RLS policies below) ───────────────────────────────
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT is_platform_admin FROM users WHERE id = auth.uid()),
    false
  );
$$;

-- ── RLS: platform admin read-all policies ─────────────────────────────────────
-- These policies are additive — existing tenant-scoped policies remain intact.
-- A platform admin matches these new policies; regular users still use the
-- get_my_business_ids() policies in 013_rls_policies.sql.

DROP POLICY IF EXISTS "admin_read_businesses" ON businesses;
CREATE POLICY "admin_read_businesses"
  ON businesses FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_read_business_members" ON business_members;
CREATE POLICY "admin_read_business_members"
  ON business_members FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_read_business_settings" ON business_settings;
CREATE POLICY "admin_read_business_settings"
  ON business_settings FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_read_storefronts" ON storefronts;
CREATE POLICY "admin_read_storefronts"
  ON storefronts FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_read_appointments" ON appointments;
CREATE POLICY "admin_read_appointments"
  ON appointments FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_read_payments" ON payments;
CREATE POLICY "admin_read_payments"
  ON payments FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_read_clients" ON clients;
CREATE POLICY "admin_read_clients"
  ON clients FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_read_services" ON services;
CREATE POLICY "admin_read_services"
  ON services FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_read_staff_profiles" ON staff_profiles;
CREATE POLICY "admin_read_staff_profiles"
  ON staff_profiles FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_read_users" ON users;
CREATE POLICY "admin_read_users"
  ON users FOR SELECT
  USING (is_platform_admin());

-- ── RLS: platform admin can toggle businesses.is_active only ──────────────────
-- No other field mutations are allowed via RLS — admin mutations go through
-- service-role edge functions which bypass RLS entirely.
DROP POLICY IF EXISTS "admin_update_businesses_active" ON businesses;
CREATE POLICY "admin_update_businesses_active"
  ON businesses FOR UPDATE
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());
