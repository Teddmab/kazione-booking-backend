-- 124_commission_completion_snapshot.sql
--
-- Financial-integrity fix: commission_amount for a completed appointment was
-- always computed LIVE, on every read, from the service's CURRENT
-- staff_commission_type/staff_commission_value — never snapshotted at
-- completion time. Editing a service's commission rate therefore silently
-- and retroactively changed the computed commission for every historical
-- completed-but-unpaid appointment tied to that service. Already-PAID
-- appointments were separately protected (commission_amount_paid, frozen at
-- pay time) — this closes the same gap for unpaid completed appointments.
--
-- This mirrors the existing precedent in 086_dual_staff.sql, which already
-- snapshots commission_split_pct onto the appointment at booking time "so
-- retro changes don't affect historical payouts" (its own words) — this
-- migration adds the missing companion snapshot for the commission RATE
-- itself, captured at completion time (not booking time, since only
-- completed appointments are ever counted for commission anywhere in this
-- system).
--
-- _snapshot / _snapshot_2 hold the PRIMARY / SECONDARY staff's own
-- already-split amount (mirrors the existing per-staff split loop in
-- appointments/index.ts), so no reader has to redo split math later.
-- All nullable — legacy completed appointments simply have none, and every
-- read path falls back to the old live calculation for those rows only.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS commission_type_snapshot   text,
  ADD COLUMN IF NOT EXISTS commission_value_snapshot   numeric(10,2),
  ADD COLUMN IF NOT EXISTS commission_amount_snapshot  numeric(10,2),
  ADD COLUMN IF NOT EXISTS commission_amount_snapshot_2 numeric(10,2);

COMMENT ON COLUMN appointments.commission_type_snapshot IS
  'The service''s staff_commission_type at the moment this appointment was marked completed. NULL for appointments completed before this column existed.';
COMMENT ON COLUMN appointments.commission_value_snapshot IS
  'The service''s staff_commission_value (or the staff''s flat commission_rate, if the service had none) at completion time.';
COMMENT ON COLUMN appointments.commission_amount_snapshot IS
  'The primary staff''s (staff_profile_id) computed commission amount at completion time — already split-adjusted for dual-staff appointments. This is what every ledger read should show for this appointment, not a fresh recalculation.';
COMMENT ON COLUMN appointments.commission_amount_snapshot_2 IS
  'The secondary staff''s (staff_profile_id_2) computed commission amount at completion time, already split-adjusted. NULL when there is no second staff member.';

-- ── get_staff_performance: prefer the snapshot when present ──────────────────
-- Same RETURNS TABLE shape as 123_staff_performance_review_count.sql — no
-- return-column change, so CREATE OR REPLACE alone is sufficient this time.

CREATE OR REPLACE FUNCTION get_staff_performance(
  p_business_id  uuid,
  p_start_date   date,
  p_end_date     date
)
RETURNS TABLE (
  staff_profile_id      uuid,
  display_name          text,
  bookings              int,
  revenue                numeric,
  unique_clients        int,
  avg_rating             numeric,
  review_count           int,
  completion_rate       numeric,
  commission_amount     numeric,
  paid_commission       numeric,
  unpaid_commission     numeric,
  referrals_initiated   int,
  referral_conversions  int,
  referral_revenue      numeric
)
AS $$
BEGIN
  RETURN QUERY
  WITH appt AS (
    SELECT a.staff_profile_id,
           a.staff_profile_id_2,
           a.id,
           a.client_id,
           a.price,
           a.status,
           a.commission_paid_at,
           a.service_id,
           a.commission_type_snapshot,
           a.commission_amount_snapshot,
           a.commission_amount_snapshot_2
      FROM appointments a
     WHERE a.business_id = p_business_id
       AND a.starts_at::date BETWEEN p_start_date AND p_end_date
       AND a.staff_profile_id IS NOT NULL
       AND a.deleted_at IS NULL
  ),
  staff_stats AS (
    SELECT ap.staff_profile_id                                        AS sp_id,
           COUNT(*)::int                                              AS bookings,
           COALESCE(SUM(ap.price) FILTER (WHERE ap.status = 'completed'), 0) AS revenue,
           COUNT(DISTINCT ap.client_id)::int                         AS unique_clients,
           CASE
             WHEN COUNT(*) FILTER (WHERE ap.status IN ('completed','cancelled','no_show')) > 0
             THEN ROUND(
               COUNT(*) FILTER (WHERE ap.status = 'completed')::numeric
               / COUNT(*) FILTER (WHERE ap.status IN ('completed','cancelled','no_show'))
               , 4)
             ELSE 0
           END                                                        AS completion_rate
      FROM appt ap
     GROUP BY ap.staff_profile_id
  ),
  staff_ratings AS (
    SELECT a.staff_profile_id AS sp_id,
           ROUND(AVG(r.rating), 2) AS avg_rating,
           COUNT(r.rating)::int AS review_count
      FROM reviews r
      JOIN appointments a ON a.id = r.appointment_id
     WHERE r.business_id = p_business_id
       AND r.is_public = true
     GROUP BY a.staff_profile_id
  ),
  commission_calc AS (
    SELECT ap.staff_profile_id AS sp_id,
           ROUND(COALESCE(SUM(
             CASE
               WHEN ap.status != 'completed' THEN 0
               -- Snapshot present → use it, already split-adjusted. Never
               -- recompute a completed appointment's commission from the
               -- service's CURRENT rate once it has a real snapshot.
               WHEN ap.commission_type_snapshot IS NOT NULL THEN ap.commission_amount_snapshot
               WHEN s.staff_commission_type = 'fixed'      THEN s.staff_commission_value
               WHEN s.staff_commission_type = 'percentage' THEN ap.price * s.staff_commission_value / 100.0
               ELSE ap.price * spr.commission_rate / 100.0
             END
           ), 0), 2) AS total_amount,
           ROUND(COALESCE(SUM(
             CASE
               WHEN ap.status != 'completed' OR ap.commission_paid_at IS NULL THEN 0
               WHEN ap.commission_type_snapshot IS NOT NULL THEN ap.commission_amount_snapshot
               WHEN s.staff_commission_type = 'fixed'      THEN s.staff_commission_value
               WHEN s.staff_commission_type = 'percentage' THEN ap.price * s.staff_commission_value / 100.0
               ELSE ap.price * spr.commission_rate / 100.0
             END
           ), 0), 2) AS paid_amount
      FROM appt ap
      JOIN staff_profiles spr ON spr.id = ap.staff_profile_id
      LEFT JOIN services  s   ON s.id   = ap.service_id
     GROUP BY ap.staff_profile_id
  ),
  referral_stats AS (
    SELECT a.referrer_staff_id                                                   AS sp_id,
           COUNT(*)::int                                                          AS referrals_initiated,
           COUNT(*) FILTER (WHERE a.status = 'completed')::int                   AS referral_conversions,
           COALESCE(SUM(a.price) FILTER (WHERE a.status = 'completed'), 0)       AS referral_revenue
      FROM appointments a
     WHERE a.business_id = p_business_id
       AND a.starts_at::date BETWEEN p_start_date AND p_end_date
       AND a.referrer_staff_id IS NOT NULL
       AND a.deleted_at IS NULL
     GROUP BY a.referrer_staff_id
  )
  SELECT sp.id                                                                    AS staff_profile_id,
         sp.display_name,
         COALESCE(ss.bookings, 0)                                                 AS bookings,
         COALESCE(ss.revenue, 0)                                                  AS revenue,
         COALESCE(ss.unique_clients, 0)                                           AS unique_clients,
         COALESCE(sr.avg_rating, 0)                                               AS avg_rating,
         COALESCE(sr.review_count, 0)                                             AS review_count,
         COALESCE(ss.completion_rate, 0)                                          AS completion_rate,
         COALESCE(cc.total_amount, 0)                                             AS commission_amount,
         COALESCE(cc.paid_amount, 0)                                              AS paid_commission,
         GREATEST(COALESCE(cc.total_amount, 0) - COALESCE(cc.paid_amount, 0), 0) AS unpaid_commission,
         COALESCE(rs.referrals_initiated, 0)                                      AS referrals_initiated,
         COALESCE(rs.referral_conversions, 0)                                     AS referral_conversions,
         COALESCE(rs.referral_revenue, 0)                                         AS referral_revenue
    FROM staff_profiles sp
    LEFT JOIN staff_stats    ss ON ss.sp_id = sp.id
    LEFT JOIN staff_ratings  sr ON sr.sp_id = sp.id
    LEFT JOIN commission_calc cc ON cc.sp_id = sp.id
    LEFT JOIN referral_stats  rs ON rs.sp_id = sp.id
   WHERE sp.business_id = p_business_id
     AND sp.is_active = true
   ORDER BY revenue DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
