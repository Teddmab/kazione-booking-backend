-- 075_staff_performance_with_referrals.sql
-- Extend get_staff_performance to include referral stats (S18).
-- Adds 3 new columns: referrals_initiated, referral_conversions, referral_revenue.
-- Requires migration 074 (referrer_staff_id column on appointments).
--
-- DROP required because CREATE OR REPLACE cannot change the return type.
DROP FUNCTION IF EXISTS get_staff_performance(uuid, date, date);

CREATE OR REPLACE FUNCTION get_staff_performance(
  p_business_id uuid,
  p_start_date  date,
  p_end_date    date
)
RETURNS TABLE (
  staff_profile_id     uuid,
  display_name         text,
  bookings             int,
  revenue              numeric,
  unique_clients       int,
  avg_rating           numeric,
  completion_rate      numeric,
  commission_amount    numeric,
  referrals_initiated  int,
  referral_conversions int,
  referral_revenue     numeric
)
AS $$
BEGIN
  RETURN QUERY
  WITH appt AS (
    SELECT a.staff_profile_id,
           a.id,
           a.client_id,
           a.price,
           a.status
      FROM appointments a
     WHERE a.business_id = p_business_id
       AND a.starts_at::date BETWEEN p_start_date AND p_end_date
       AND a.staff_profile_id IS NOT NULL
  ),
  staff_stats AS (
    SELECT ap.staff_profile_id                                      AS sp_id,
           COUNT(*)::int                                            AS bookings,
           COALESCE(SUM(ap.price) FILTER (WHERE ap.status = 'completed'), 0) AS revenue,
           COUNT(DISTINCT ap.client_id)::int                        AS unique_clients,
           CASE
             WHEN COUNT(*) FILTER (WHERE ap.status IN ('completed','cancelled','no_show')) > 0
             THEN ROUND(
               COUNT(*) FILTER (WHERE ap.status = 'completed')::numeric
               / COUNT(*) FILTER (WHERE ap.status IN ('completed','cancelled','no_show'))
               , 4)
             ELSE 0
           END                                                      AS completion_rate
      FROM appt ap
     GROUP BY ap.staff_profile_id
  ),
  staff_ratings AS (
    SELECT a.staff_profile_id AS sp_id,
           ROUND(AVG(r.rating), 2) AS avg_rating
      FROM reviews r
      JOIN appointments a ON a.id = r.appointment_id
     WHERE r.business_id = p_business_id
       AND r.is_public = true
     GROUP BY a.staff_profile_id
  ),
  referral_stats AS (
    SELECT
      a.referrer_staff_id                                                      AS sp_id,
      COUNT(*)::int                                                             AS referrals_initiated,
      COUNT(*) FILTER (WHERE a.status = 'completed')::int                     AS referral_conversions,
      COALESCE(SUM(a.price) FILTER (WHERE a.status = 'completed'), 0)         AS referral_revenue
    FROM appointments a
    WHERE a.business_id = p_business_id
      AND a.starts_at::date BETWEEN p_start_date AND p_end_date
      AND a.referrer_staff_id IS NOT NULL
    GROUP BY a.referrer_staff_id
  )
  SELECT sp.id                                                          AS staff_profile_id,
         sp.display_name,
         COALESCE(ss.bookings, 0)                                       AS bookings,
         COALESCE(ss.revenue, 0)                                        AS revenue,
         COALESCE(ss.unique_clients, 0)                                 AS unique_clients,
         COALESCE(sr.avg_rating, 0)                                     AS avg_rating,
         COALESCE(ss.completion_rate, 0)                                AS completion_rate,
         ROUND(COALESCE(ss.revenue, 0) * sp.commission_rate / 100, 2)  AS commission_amount,
         COALESCE(rs.referrals_initiated, 0)                            AS referrals_initiated,
         COALESCE(rs.referral_conversions, 0)                           AS referral_conversions,
         COALESCE(rs.referral_revenue, 0)                               AS referral_revenue
    FROM staff_profiles sp
    LEFT JOIN staff_stats    ss ON ss.sp_id = sp.id
    LEFT JOIN staff_ratings  sr ON sr.sp_id = sp.id
    LEFT JOIN referral_stats rs ON rs.sp_id = sp.id
   WHERE sp.business_id = p_business_id
     AND sp.is_active = true
   ORDER BY revenue DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
