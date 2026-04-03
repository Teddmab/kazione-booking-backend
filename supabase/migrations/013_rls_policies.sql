-- ---------------------------------------------------------------------------
-- 013_rls_policies.sql  -  Row-Level Security for all tenant tables
-- ---------------------------------------------------------------------------

-- =========================================================================
-- Helper: get_user_role(p_business_id)
-- Returns the current user's role within a business, or NULL if not a member.
-- =========================================================================

CREATE OR REPLACE FUNCTION get_user_role(p_business_id uuid)
RETURNS text
AS $$
  SELECT bm.role::text
    FROM business_members bm
   WHERE bm.business_id = p_business_id
     AND bm.user_id     = auth.uid()
     AND bm.is_active   = true
   LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;


-- =========================================================================
-- Enable RLS on every table from migrations 002-010
-- =========================================================================

ALTER TABLE businesses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE services            ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_translations ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_services      ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_time_off      ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients             ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_status_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses            ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefronts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE storefront_gallery  ENABLE ROW LEVEL SECURITY;
ALTER TABLE promotions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews             ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE translations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_sessions      ENABLE ROW LEVEL SECURITY;


-- =========================================================================
-- CORE TABLES (002)
-- =========================================================================

-- -- businesses ---------------------------------------------------------------
CREATE POLICY businesses_select ON businesses FOR SELECT
  USING (id IN (SELECT get_my_business_ids()));
CREATE POLICY businesses_insert ON businesses FOR INSERT
  WITH CHECK (true);  -- any authenticated user can create a business
CREATE POLICY businesses_update ON businesses FOR UPDATE
  USING (id IN (SELECT get_my_business_ids()));
CREATE POLICY businesses_delete ON businesses FOR DELETE
  USING (get_user_role(id) IN ('owner'));

-- -- users --------------------------------------------------------------------
CREATE POLICY users_select_own ON users FOR SELECT
  USING (id = auth.uid());
CREATE POLICY users_select_team ON users FOR SELECT
  USING (id IN (
    SELECT bm.user_id FROM business_members bm
     WHERE bm.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY users_update_own ON users FOR UPDATE
  USING (id = auth.uid());

-- -- business_members ---------------------------------------------------------
CREATE POLICY bm_select ON business_members FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY bm_insert ON business_members FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY bm_update ON business_members FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY bm_delete ON business_members FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- business_settings --------------------------------------------------------
CREATE POLICY bs_select ON business_settings FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY bs_insert ON business_settings FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY bs_update ON business_settings FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY bs_delete ON business_settings FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));


-- =========================================================================
-- SERVICE CATALOG (003)
-- =========================================================================

-- -- service_categories -------------------------------------------------------
CREATE POLICY sc_select_global ON service_categories FOR SELECT
  USING (business_id IS NULL);  -- global categories visible to all
CREATE POLICY sc_select_tenant ON service_categories FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sc_insert ON service_categories FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sc_update ON service_categories FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sc_delete ON service_categories FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- services -----------------------------------------------------------------
-- Tenant members can see all their services; anon/public can see published ones
CREATE POLICY svc_select_tenant ON services FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY svc_select_public ON services FOR SELECT
  USING (is_public = true AND is_active = true);
CREATE POLICY svc_insert ON services FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY svc_update ON services FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY svc_delete ON services FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- service_translations -----------------------------------------------------
-- Always public (anon can read for i18n on storefront)
CREATE POLICY st_select_public ON service_translations FOR SELECT
  USING (true);
CREATE POLICY st_insert ON service_translations FOR INSERT
  WITH CHECK (service_id IN (
    SELECT s.id FROM services s WHERE s.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY st_update ON service_translations FOR UPDATE
  USING (service_id IN (
    SELECT s.id FROM services s WHERE s.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY st_delete ON service_translations FOR DELETE
  USING (service_id IN (
    SELECT s.id FROM services s
     WHERE get_user_role(s.business_id) IN ('owner', 'manager')
  ));


-- =========================================================================
-- STAFF TABLES (004)
-- =========================================================================

-- -- staff_profiles -----------------------------------------------------------
CREATE POLICY sp_select_tenant ON staff_profiles FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sp_select_public ON staff_profiles FOR SELECT
  USING (is_active = true);  -- public: booking page shows active staff
CREATE POLICY sp_insert ON staff_profiles FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sp_update ON staff_profiles FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sp_delete ON staff_profiles FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- staff_services -----------------------------------------------------------
CREATE POLICY ss_select ON staff_services FOR SELECT
  USING (staff_profile_id IN (
    SELECT sp.id FROM staff_profiles sp WHERE sp.business_id IN (SELECT get_my_business_ids())
  ) OR staff_profile_id IN (
    SELECT sp.id FROM staff_profiles sp WHERE sp.is_active = true
  ));
CREATE POLICY ss_insert ON staff_services FOR INSERT
  WITH CHECK (staff_profile_id IN (
    SELECT sp.id FROM staff_profiles sp WHERE sp.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY ss_update ON staff_services FOR UPDATE
  USING (staff_profile_id IN (
    SELECT sp.id FROM staff_profiles sp WHERE sp.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY ss_delete ON staff_services FOR DELETE
  USING (staff_profile_id IN (
    SELECT sp.id FROM staff_profiles sp
     WHERE get_user_role(sp.business_id) IN ('owner', 'manager')
  ));

-- -- staff_working_hours ------------------------------------------------------
CREATE POLICY swh_select ON staff_working_hours FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids())
      OR staff_profile_id IN (SELECT sp.id FROM staff_profiles sp WHERE sp.is_active = true));
CREATE POLICY swh_insert ON staff_working_hours FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY swh_update ON staff_working_hours FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY swh_delete ON staff_working_hours FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- staff_time_off -----------------------------------------------------------
CREATE POLICY sto_select ON staff_time_off FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sto_insert ON staff_time_off FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sto_update ON staff_time_off FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sto_delete ON staff_time_off FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));


-- =========================================================================
-- CLIENTS (005)
-- =========================================================================

CREATE POLICY clients_select ON clients FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY clients_insert ON clients FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY clients_update ON clients FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY clients_delete ON clients FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));


-- =========================================================================
-- APPOINTMENTS (006)
-- =========================================================================

-- -- appointments -------------------------------------------------------------
CREATE POLICY appt_select ON appointments FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY appt_insert ON appointments FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY appt_update ON appointments FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY appt_delete ON appointments FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- appointment_services -----------------------------------------------------
CREATE POLICY as_select ON appointment_services FOR SELECT
  USING (appointment_id IN (
    SELECT a.id FROM appointments a WHERE a.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY as_insert ON appointment_services FOR INSERT
  WITH CHECK (appointment_id IN (
    SELECT a.id FROM appointments a WHERE a.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY as_update ON appointment_services FOR UPDATE
  USING (appointment_id IN (
    SELECT a.id FROM appointments a WHERE a.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY as_delete ON appointment_services FOR DELETE
  USING (appointment_id IN (
    SELECT a.id FROM appointments a
     WHERE get_user_role(a.business_id) IN ('owner', 'manager')
  ));

-- -- appointment_status_log ---------------------------------------------------
CREATE POLICY asl_select ON appointment_status_log FOR SELECT
  USING (appointment_id IN (
    SELECT a.id FROM appointments a WHERE a.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY asl_insert ON appointment_status_log FOR INSERT
  WITH CHECK (appointment_id IN (
    SELECT a.id FROM appointments a WHERE a.business_id IN (SELECT get_my_business_ids())
  ));
-- Status log is append-only: no UPDATE or DELETE policies


-- =========================================================================
-- PAYMENTS (007)
-- =========================================================================

CREATE POLICY pay_select ON payments FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY pay_insert ON payments FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY pay_update ON payments FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY pay_delete ON payments FOR DELETE
  USING (get_user_role(business_id) IN ('owner'));


-- =========================================================================
-- FINANCE (008)
-- =========================================================================

-- -- suppliers ----------------------------------------------------------------
CREATE POLICY sup_select ON suppliers FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sup_insert ON suppliers FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sup_update ON suppliers FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sup_delete ON suppliers FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- expenses -----------------------------------------------------------------
CREATE POLICY exp_select ON expenses FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY exp_insert ON expenses FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY exp_update ON expenses FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY exp_delete ON expenses FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- supplier_orders ----------------------------------------------------------
CREATE POLICY so_select ON supplier_orders FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY so_insert ON supplier_orders FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY so_update ON supplier_orders FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY so_delete ON supplier_orders FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- supplier_order_items -----------------------------------------------------
CREATE POLICY soi_select ON supplier_order_items FOR SELECT
  USING (order_id IN (
    SELECT so.id FROM supplier_orders so WHERE so.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY soi_insert ON supplier_order_items FOR INSERT
  WITH CHECK (order_id IN (
    SELECT so.id FROM supplier_orders so WHERE so.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY soi_update ON supplier_order_items FOR UPDATE
  USING (order_id IN (
    SELECT so.id FROM supplier_orders so WHERE so.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY soi_delete ON supplier_order_items FOR DELETE
  USING (order_id IN (
    SELECT so.id FROM supplier_orders so
     WHERE get_user_role(so.business_id) IN ('owner', 'manager')
  ));


-- =========================================================================
-- STOREFRONTS (009)
-- =========================================================================

-- -- storefronts --------------------------------------------------------------
-- Tenant members see their own; public sees published + active marketplace
CREATE POLICY sf_select_tenant ON storefronts FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sf_select_public ON storefronts FOR SELECT
  USING (is_published = true AND marketplace_status = 'active');
CREATE POLICY sf_insert ON storefronts FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sf_update ON storefronts FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY sf_delete ON storefronts FOR DELETE
  USING (get_user_role(business_id) IN ('owner'));

-- -- storefront_gallery -------------------------------------------------------
CREATE POLICY sg_select_tenant ON storefront_gallery FOR SELECT
  USING (storefront_id IN (
    SELECT sf.id FROM storefronts sf WHERE sf.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY sg_select_public ON storefront_gallery FOR SELECT
  USING (storefront_id IN (
    SELECT sf.id FROM storefronts sf
     WHERE sf.is_published = true AND sf.marketplace_status = 'active'
  ));
CREATE POLICY sg_insert ON storefront_gallery FOR INSERT
  WITH CHECK (storefront_id IN (
    SELECT sf.id FROM storefronts sf WHERE sf.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY sg_update ON storefront_gallery FOR UPDATE
  USING (storefront_id IN (
    SELECT sf.id FROM storefronts sf WHERE sf.business_id IN (SELECT get_my_business_ids())
  ));
CREATE POLICY sg_delete ON storefront_gallery FOR DELETE
  USING (storefront_id IN (
    SELECT sf.id FROM storefronts sf
     WHERE get_user_role(sf.business_id) IN ('owner', 'manager')
  ));

-- -- promotions ---------------------------------------------------------------
CREATE POLICY promo_select_tenant ON promotions FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY promo_select_public ON promotions FOR SELECT
  USING (is_active = true);  -- public: storefront shows active promos
CREATE POLICY promo_insert ON promotions FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY promo_update ON promotions FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY promo_delete ON promotions FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));

-- -- reviews ------------------------------------------------------------------
-- Tenant members see all; public sees is_public=true
CREATE POLICY rev_select_tenant ON reviews FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY rev_select_public ON reviews FOR SELECT
  USING (is_public = true);
CREATE POLICY rev_insert ON reviews FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY rev_update ON reviews FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY rev_delete ON reviews FOR DELETE
  USING (get_user_role(business_id) IN ('owner', 'manager'));


-- =========================================================================
-- NOTIFICATIONS (010)
-- =========================================================================

-- -- notifications ------------------------------------------------------------
-- Users can only see and mark-read their own notifications
CREATE POLICY notif_select ON notifications FOR SELECT
  USING (user_id = auth.uid());
CREATE POLICY notif_insert ON notifications FOR INSERT
  WITH CHECK (
    business_id IN (SELECT get_my_business_ids())
    OR user_id = auth.uid()
  );
CREATE POLICY notif_update ON notifications FOR UPDATE
  USING (user_id = auth.uid());
-- No delete: notifications are kept for audit

-- -- translations -------------------------------------------------------------
CREATE POLICY tr_select ON translations FOR SELECT
  USING (true);  -- public (i18n data is always readable)
CREATE POLICY tr_insert ON translations FOR INSERT
  WITH CHECK (
    business_id IS NULL  -- system translations
    OR business_id IN (SELECT get_my_business_ids())
  );
CREATE POLICY tr_update ON translations FOR UPDATE
  USING (
    business_id IS NULL
    OR business_id IN (SELECT get_my_business_ids())
  );
CREATE POLICY tr_delete ON translations FOR DELETE
  USING (
    business_id IS NOT NULL
    AND get_user_role(business_id) IN ('owner', 'manager')
  );

-- -- guest_sessions -----------------------------------------------------------
-- Token-based access: no auth required for INSERT or SELECT
CREATE POLICY gs_select ON guest_sessions FOR SELECT
  USING (true);
CREATE POLICY gs_insert ON guest_sessions FOR INSERT
  WITH CHECK (true);
CREATE POLICY gs_delete ON guest_sessions FOR DELETE
  USING (true);  -- cleanup function needs to delete expired rows


-- =========================================================================
-- GRANTS
-- =========================================================================

GRANT USAGE ON SCHEMA public TO authenticated, anon;

-- Authenticated users get full access (RLS enforces row-level scope)
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated;

-- Anon users get SELECT on public-facing storefront tables only
GRANT SELECT ON storefronts,
                storefront_gallery,
                services,
                service_categories,
                service_translations,
                staff_profiles,
                staff_services,
                staff_working_hours,
                promotions,
                reviews,
                translations,
                guest_sessions
  TO anon;

-- Anon can insert guest_sessions (token-based booking lookup)
GRANT INSERT ON guest_sessions TO anon;
