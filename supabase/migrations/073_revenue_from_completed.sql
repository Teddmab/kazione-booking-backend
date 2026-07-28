-- ---------------------------------------------------------------------------
-- 073_revenue_from_completed.sql
-- Fix get_revenue_summary + get_income_breakdown to count revenue from
-- completed appointments even when the linked payment row was never marked
-- 'paid' (historical data before the payment-settlement fix in appointments PATCH).
--
-- Logic: a completed appointment counts as income if:
--   (a) it has a payments row with status='paid' in the date range, OR
--   (b) it has no paid payment row at all (unreconciled cash) and its
--       starts_at falls within the date range.
-- ---------------------------------------------------------------------------


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
  WITH effective_income AS (
    SELECT
      COALESCE(p.amount, a.price, 0) AS amount,
      COALESCE(p.method, 'cash')     AS method,
      a.id                           AS appointment_id
    FROM appointments a
    LEFT JOIN payments p
      ON p.appointment_id = a.id
     AND p.status = 'paid'
    WHERE a.business_id = p_business_id
      AND a.status      = 'completed'
      AND a.deleted_at IS NULL
      AND (
        (p.id IS NOT NULL AND p.paid_at::date BETWEEN p_start_date AND p_end_date)
        OR
        (p.id IS NULL     AND a.starts_at::date BETWEEN p_start_date AND p_end_date)
      )
      AND COALESCE(p.amount, a.price, 0) > 0
  ),
  total_income AS (
    SELECT COALESCE(SUM(ei.amount), 0) AS val FROM effective_income ei
  ),
  total_expenses AS (
    SELECT COALESCE(SUM(e.amount), 0) AS val
      FROM expenses e
     WHERE e.business_id = p_business_id
       AND e.date BETWEEN p_start_date AND p_end_date
  ),
  by_service AS (
    SELECT s.id   AS service_id,
           s.name AS service_name,
           COALESCE(SUM(ei.amount), 0)       AS total,
           COUNT(ei.appointment_id)::int      AS count
      FROM effective_income ei
      JOIN appointments a ON a.id = ei.appointment_id
      JOIN services     s ON s.id = a.service_id
     GROUP BY s.id, s.name
     ORDER BY total DESC
  ),
  by_staff AS (
    SELECT sp.id           AS staff_profile_id,
           sp.display_name,
           COALESCE(SUM(ei.amount), 0)       AS total,
           COUNT(ei.appointment_id)::int      AS count
      FROM effective_income ei
      JOIN appointments   a  ON a.id  = ei.appointment_id
      JOIN staff_profiles sp ON sp.id = a.staff_profile_id
     GROUP BY sp.id, sp.display_name
     ORDER BY total DESC
  ),
  by_method AS (
    SELECT ei.method,
           COALESCE(SUM(ei.amount), 0)       AS total,
           COUNT(ei.appointment_id)::int      AS count
      FROM effective_income ei
     GROUP BY ei.method
     ORDER BY total DESC
  )
  SELECT jsonb_build_object(
    'total_income',   (SELECT val FROM total_income),
    'total_expenses', (SELECT val FROM total_expenses),
    'net_profit',     (SELECT val FROM total_income) - (SELECT val FROM total_expenses),
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


CREATE OR REPLACE FUNCTION get_income_breakdown(
  p_business_id uuid,
  p_start_date  date,
  p_end_date    date,
  p_group_by    text DEFAULT 'month'   -- 'day' | 'week' | 'month'
)
RETURNS TABLE (
  period            text,
  amount            numeric,
  appointment_count int
)
AS $$
BEGIN
  RETURN QUERY
  WITH effective_income AS (
    SELECT
      COALESCE(p.amount, a.price, 0) AS amount,
      CASE
        WHEN p.id IS NOT NULL THEN p.paid_at
        ELSE a.starts_at
      END AS effective_date,
      a.id AS appointment_id
    FROM appointments a
    LEFT JOIN payments p
      ON p.appointment_id = a.id
     AND p.status = 'paid'
    WHERE a.business_id = p_business_id
      AND a.status      = 'completed'
      AND a.deleted_at IS NULL
      AND (
        (p.id IS NOT NULL AND p.paid_at::date BETWEEN p_start_date AND p_end_date)
        OR
        (p.id IS NULL     AND a.starts_at::date BETWEEN p_start_date AND p_end_date)
      )
      AND COALESCE(p.amount, a.price, 0) > 0
  )
  SELECT
    CASE p_group_by
      WHEN 'day'   THEN to_char(date_trunc('day',   ei.effective_date), 'YYYY-MM-DD')
      WHEN 'week'  THEN to_char(date_trunc('week',  ei.effective_date), 'IYYY-"W"IW')
      WHEN 'month' THEN to_char(date_trunc('month', ei.effective_date), 'YYYY-MM')
      ELSE              to_char(date_trunc('month', ei.effective_date), 'YYYY-MM')
    END                                    AS period,
    COALESCE(SUM(ei.amount), 0)            AS amount,
    COUNT(DISTINCT ei.appointment_id)::int AS appointment_count
  FROM effective_income ei
  GROUP BY 1
  ORDER BY 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
