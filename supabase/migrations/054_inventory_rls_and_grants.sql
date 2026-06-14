-- ─────────────────────────────────────────────────────────────────────────────
-- 054_inventory_rls_and_grants.sql
--
-- 1. Enable RLS on the three new inventory tables.
-- 2. Add RLS policies that mirror the pattern used for other business tables.
-- 3. Grant service_role access to ALL public tables so supabaseAdmin (Edge
--    Functions) can bypass RLS and access any table.
-- 4. Add ALTER DEFAULT PRIVILEGES so future migrations automatically inherit
--    the same grants for authenticated and service_role.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Enable RLS on new inventory tables ────────────────────────────────────────

ALTER TABLE product_catalog       ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_product_usage ENABLE ROW LEVEL SECURITY;

-- ── RLS policies: product_catalog ────────────────────────────────────────────

CREATE POLICY pc_select ON product_catalog FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY pc_insert ON product_catalog FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY pc_update ON product_catalog FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY pc_delete ON product_catalog FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- ── RLS policies: stock_movements ────────────────────────────────────────────

CREATE POLICY sm_select ON stock_movements FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY sm_insert ON stock_movements FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));

-- stock_movements is append-only; no UPDATE or DELETE policies

-- ── RLS policies: service_product_usage ──────────────────────────────────────
-- Accessible by any member who can see the linked service's business.

CREATE POLICY spu_select ON service_product_usage FOR SELECT
  USING (
    service_id IN (
      SELECT id FROM services
       WHERE business_id IN (SELECT get_my_business_ids())
    )
  );

CREATE POLICY spu_insert ON service_product_usage FOR INSERT
  WITH CHECK (
    service_id IN (
      SELECT id FROM services
       WHERE business_id IN (SELECT get_my_business_ids())
    )
  );

CREATE POLICY spu_delete ON service_product_usage FOR DELETE
  USING (
    service_id IN (
      SELECT id FROM services
       WHERE business_id IN (SELECT get_my_business_ids())
    )
  );

-- ── Grant service_role full access to all public tables ───────────────────────
-- Edge Functions use supabaseAdmin (service_role key) which bypasses RLS.
-- service_role must still have table-level GRANTs to execute queries.

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO service_role;

-- ── Default privileges — auto-grant to future tables ─────────────────────────
-- Without this, tables created in later migrations do not inherit grants.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO authenticated, service_role;
