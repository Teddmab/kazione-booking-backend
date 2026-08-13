-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 103 — Financial Integrity
--   · Adds 'commission' and 'cogs' to expense_category ENUM
--   · Rebuilds get_revenue_summary — adds total_fixed_costs, total_cogs,
--     total_commission_paid; corrects net_profit formula
--   · Rebuilds get_staff_performance — uses per-service commission type/value
--     with fallback to staff_profiles.commission_rate
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Extend expense_category ENUM
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'commission';
ALTER TYPE expense_category ADD VALUE IF NOT EXISTS 'cogs';

-- 2) get_revenue_summary — add cost buckets and correct net_profit
CREATE OR REPLACE FUNCTION get_revenue_summary(
  p_business_id uuid,
  p_start_date  date,
  p_end_date    date
)
RETURNS jsonb
AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH paid_payments AS (
    SELECT p.id, p.amount, p.method, p.appointment_id
      FROM payments p
     WHERE p.business_id = p_business_id
       AND p.status = 'paid'
       AND p.is_test = false
       AND p.paid_at::date BETWEEN p_start_date AND p_end_date
  ),
  total_income AS (
    SELECT COALESCE(SUM(pp.amount), 0) AS val FROM paid_payments pp
  ),
  total_expenses AS (
    SELECT COALESCE(SUM(e.amount), 0) AS val
      FROM expenses e
     WHERE e.business_id = p_business_id
       AND e.date BETWEEN p_start_date AND p_end_date
  ),
  total_fixed_costs AS (
    SELECT COALESCE(SUM(fc.amount), 0) AS val
      FROM fixed_costs fc
     WHERE fc.business_id = p_business_id
       AND fc.cost_date BETWEEN p_start_date AND p_end_date
  ),
  total_cogs AS (
    SELECT COALESCE(SUM(ABS(sm.quantity) * sm.unit_cost), 0) AS val
      FROM stock_movements sm
     WHERE sm.business_id = p_business_id
       AND sm.movement_type = 'service_use'
       AND sm.unit_cost IS NOT NULL
       AND sm.created_at::date BETWEEN p_start_date AND p_end_date
  ),
  total_commission_paid AS (
    SELECT ROUND(COALESCE(SUM(
      CASE
        WHEN s.staff_commission_type = 'flat'       THEN s.staff_commission_value
        WHEN s.staff_commission_type = 'percentage' THEN a.price * s.staff_commission_value / 100.0
        ELSE a.price * sp.commission_rate / 100.0
      END
    ), 0), 2) AS val
      FROM appointments a
      JOIN staff_profiles sp ON sp.id = a.staff_profile_id
      LEFT JOIN services  s  ON s.id  = a.service_id
     WHERE a.business_id = p_business_id
       AND a.deleted_at IS NULL
       AND a.status = 'completed'
       AND a.commission_paid_at IS NOT NULL
       AND a.commission_paid_at::date BETWEEN p_start_date AND p_end_date
  ),
  by_service AS (
    SELECT s.id   AS service_id,
           s.name AS service_name,
           COALESCE(SUM(pp.amount), 0) AS total,
           COUNT(pp.id)::int AS count
      FROM paid_payments pp
      JOIN appointments a ON a.id = pp.appointment_id
      JOIN services     s ON s.id = a.service_id
     GROUP BY s.id, s.name
     ORDER BY total DESC
  ),
  by_staff AS (
    SELECT sp.id           AS staff_profile_id,
           sp.display_name,
           COALESCE(SUM(pp.amount), 0) AS total,
           COUNT(pp.id)::int AS count
      FROM paid_payments pp
      JOIN appointments  a  ON a.id  = pp.appointment_id
      JOIN staff_profiles sp ON sp.id = a.staff_profile_id
     GROUP BY sp.id, sp.display_name
     ORDER BY total DESC
  ),
  by_method AS (
    SELECT pp.method,
           COALESCE(SUM(pp.amount), 0) AS total,
           COUNT(pp.id)::int AS count
      FROM paid_payments pp
     GROUP BY pp.method
     ORDER BY total DESC
  )
  SELECT jsonb_build_object(
    'total_income',          (SELECT val FROM total_income),
    'total_expenses',        (SELECT val FROM total_expenses),
    'total_fixed_costs',     (SELECT val FROM total_fixed_costs),
    'total_cogs',            (SELECT val FROM total_cogs),
    'total_commission_paid', (SELECT val FROM total_commission_paid),
    'net_profit',
      (SELECT val FROM total_income)
      - (SELECT val FROM total_expenses)
      - (SELECT val FROM total_fixed_costs)
      - (SELECT val FROM total_cogs)
      - (SELECT val FROM total_commission_paid),
    'income_by_service', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'service_id', service_id, 'service_name', service_name,
         'total', total, 'count', count
       )) FROM by_service), '[]'::jsonb),
    'income_by_staff', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'staff_profile_id', staff_profile_id, 'display_name', display_name,
         'total', total, 'count', count
       )) FROM by_staff), '[]'::jsonb),
    'income_by_payment_method', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'method', method, 'total', total, 'count', count
       )) FROM by_method), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- 3) get_staff_performance — per-service commission type/value with fallback
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
  revenue               numeric,
  unique_clients        int,
  avg_rating            numeric,
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
           ROUND(AVG(r.rating), 2) AS avg_rating
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
