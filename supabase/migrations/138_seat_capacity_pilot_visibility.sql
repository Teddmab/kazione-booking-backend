-- ─────────────────────────────────────────────────────────────────────────────
-- 138_seat_capacity_pilot_visibility.sql
--
-- SPRINT: Salon Seat Capacity — Stage 2 frontend follow-up.
-- 137_seat_capacity_enforcement.sql deliberately gave
-- capacity_enforcement_pilot_businesses NO RLS policies at all, since at the
-- time nothing outside the SECURITY DEFINER enforcement functions needed to
-- read it. The Stage 2 UI now needs an owner to see whether THEIR OWN
-- business is pilot-eligible, so the "enforce real limits" toggle can be
-- shown (not hidden) only where it would actually do something — never as a
-- disconnected, always-visible switch that silently no-ops for every
-- non-pilot business. This adds exactly one read-only SELECT policy,
-- scoped to that business's own owner/manager, mirroring
-- appointment_capacity_shadow_log's existing policy (136) byte-for-byte in
-- shape. No write policy — pilot membership is still support-managed only,
-- via direct INSERT/DELETE against this table, never through the app.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE POLICY "business_read_capacity_enforcement_pilot_businesses"
  ON capacity_enforcement_pilot_businesses FOR SELECT
  USING (
    business_id IN (SELECT get_my_business_ids())
    AND get_user_role(business_id) IN ('owner', 'manager')
  );
