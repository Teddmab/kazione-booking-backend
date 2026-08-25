-- Adds review_count alongside the existing avg_rating in get_staff_performance
-- so the frontend can show "4.8 from 12 reviews" instead of just the average —
-- same join/WHERE as avg_rating, so the two numbers always stay consistent.
--
-- Postgres won't let CREATE OR REPLACE change a function's return columns
-- (SQLSTATE 42P13) — the old signature has to be dropped first.
DROP FUNCTION IF EXISTS get_staff_performance(uuid, date, date);

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
           a.id,
           a.client_id,
           a.price,
           a.status,
           a.commission_paid_at,
           a.service_id
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
               WHEN s.staff_commission_type = 'flat'       THEN s.staff_commission_value
               WHEN s.staff_commission_type = 'percentage' THEN ap.price * s.staff_commission_value / 100.0
               ELSE ap.price * spr.commission_rate / 100.0
             END
           ) FILTER (WHERE ap.status = 'completed'), 0), 2) AS total_amount,
           ROUND(COALESCE(SUM(
             CASE
               WHEN s.staff_commission_type = 'flat'       THEN s.staff_commission_value
               WHEN s.staff_commission_type = 'percentage' THEN ap.price * s.staff_commission_value / 100.0
               ELSE ap.price * spr.commission_rate / 100.0
             END
           ) FILTER (WHERE ap.status = 'completed' AND ap.commission_paid_at IS NOT NULL), 0), 2) AS paid_amount
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
