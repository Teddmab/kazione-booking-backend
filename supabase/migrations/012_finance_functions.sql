-- ---------------------------------------------------------------------------
-- 012_finance_functions.sql  -  Revenue, expense, tax, staff performance,
--                                supplier spend, and owner dashboard KPIs
-- ---------------------------------------------------------------------------


-- ═══════════════════════════════════════════════════════════════════════════
-- 1) get_revenue_summary
--    Aggregates income, expenses, profit, and breakdowns by service, staff,
--    and payment method for a date range.
-- ═══════════════════════════════════════════════════════════════════════════

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


-- ═══════════════════════════════════════════════════════════════════════════
-- 2) get_income_breakdown
--    Groups paid-payment totals by day / week / month.
-- ═══════════════════════════════════════════════════════════════════════════

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
  SELECT
    CASE p_group_by
      WHEN 'day'   THEN to_char(date_trunc('day',   p.paid_at), 'YYYY-MM-DD')
      WHEN 'week'  THEN to_char(date_trunc('week',  p.paid_at), 'IYYY-"W"IW')
      WHEN 'month' THEN to_char(date_trunc('month', p.paid_at), 'YYYY-MM')
      ELSE              to_char(date_trunc('month', p.paid_at), 'YYYY-MM')
    END                            AS period,
    COALESCE(SUM(p.amount), 0)     AS amount,
    COUNT(DISTINCT p.appointment_id)::int AS appointment_count
  FROM payments p
  WHERE p.business_id = p_business_id
    AND p.status = 'paid'
    AND p.paid_at::date BETWEEN p_start_date AND p_end_date
  GROUP BY 1
  ORDER BY 1;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- ═══════════════════════════════════════════════════════════════════════════
-- 3) get_expense_breakdown
--    Groups expenses by category for a date range.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_expense_breakdown(
  p_business_id uuid,
  p_start_date  date,
  p_end_date    date
)
RETURNS TABLE (
  category      expense_category,
  amount        numeric,
  expense_count int
)
AS $$
BEGIN
  RETURN QUERY
  SELECT e.category,
         COALESCE(SUM(e.amount), 0) AS amount,
         COUNT(*)::int              AS expense_count
    FROM expenses e
   WHERE e.business_id = p_business_id
     AND e.date BETWEEN p_start_date AND p_end_date
   GROUP BY e.category
   ORDER BY amount DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4) get_tax_summary
--    Annual or quarterly tax report: gross income, tax collected,
--    expenses, profit, and per-period breakdown.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_tax_summary(
  p_business_id uuid,
  p_year        int,
  p_quarter     int DEFAULT NULL   -- 1-4 or NULL for full year
)
RETURNS jsonb
AS $$
DECLARE
  v_start  date;
  v_end    date;
  v_result jsonb;
BEGIN
  -- Resolve date range
  IF p_quarter IS NOT NULL THEN
    v_start := make_date(p_year, (p_quarter - 1) * 3 + 1, 1);
    v_end   := (v_start + interval '3 months' - interval '1 day')::date;
  ELSE
    v_start := make_date(p_year, 1, 1);
    v_end   := make_date(p_year, 12, 31);
  END IF;

  WITH income AS (
    SELECT COALESCE(SUM(p.amount), 0)     AS gross,
           COALESCE(SUM(p.tax_amount), 0) AS tax_collected
      FROM payments p
     WHERE p.business_id = p_business_id
       AND p.status = 'paid'
       AND p.paid_at::date BETWEEN v_start AND v_end
  ),
  expenses AS (
    SELECT COALESCE(SUM(e.amount), 0) AS total
      FROM expenses e
     WHERE e.business_id = p_business_id
       AND e.date BETWEEN v_start AND v_end
  ),
  period_breakdown AS (
    SELECT to_char(date_trunc('month', p.paid_at), 'YYYY-MM') AS period,
           COALESCE(SUM(p.amount), 0)     AS income,
           COALESCE(SUM(p.tax_amount), 0) AS tax
      FROM payments p
     WHERE p.business_id = p_business_id
       AND p.status = 'paid'
       AND p.paid_at::date BETWEEN v_start AND v_end
     GROUP BY 1
     ORDER BY 1
  ),
  expense_breakdown AS (
    SELECT to_char(date_trunc('month', e.date), 'YYYY-MM') AS period,
           COALESCE(SUM(e.amount), 0) AS expenses
      FROM expenses e
     WHERE e.business_id = p_business_id
       AND e.date BETWEEN v_start AND v_end
     GROUP BY 1
  )
  SELECT jsonb_build_object(
    'year',           p_year,
    'quarter',        p_quarter,
    'start_date',     v_start,
    'end_date',       v_end,
    'gross_income',   (SELECT gross FROM income),
    'tax_collected',  (SELECT tax_collected FROM income),
    'total_expenses', (SELECT total FROM expenses),
    'net_profit',     (SELECT gross FROM income) - (SELECT total FROM expenses),
    'period_breakdown', COALESCE(
      (SELECT jsonb_agg(jsonb_build_object(
         'period',   pb.period,
         'income',   pb.income,
         'tax',      pb.tax,
         'expenses', COALESCE(eb.expenses, 0),
         'profit',   pb.income - COALESCE(eb.expenses, 0)
       ) ORDER BY pb.period)
         FROM period_breakdown pb
         LEFT JOIN expense_breakdown eb ON eb.period = pb.period
      ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- ═══════════════════════════════════════════════════════════════════════════
-- 5) get_staff_performance
--    Per-staff KPIs: bookings, revenue, unique clients, avg rating,
--    completion rate, and commission amount.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_staff_performance(
  p_business_id uuid,
  p_start_date  date,
  p_end_date    date
)
RETURNS TABLE (
  staff_profile_id  uuid,
  display_name      text,
  bookings          int,
  revenue           numeric,
  unique_clients    int,
  avg_rating        numeric,
  completion_rate   numeric,
  commission_amount numeric
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
    SELECT r.business_id,
           a.staff_profile_id AS sp_id,
           ROUND(AVG(r.rating), 2) AS avg_rating
      FROM reviews r
      JOIN appointments a ON a.id = r.appointment_id
     WHERE r.business_id = p_business_id
       AND r.is_public = true
     GROUP BY r.business_id, a.staff_profile_id
  )
  SELECT sp.id                                        AS staff_profile_id,
         sp.display_name,
         COALESCE(ss.bookings, 0)                     AS bookings,
         COALESCE(ss.revenue, 0)                      AS revenue,
         COALESCE(ss.unique_clients, 0)               AS unique_clients,
         COALESCE(sr.avg_rating, 0)                   AS avg_rating,
         COALESCE(ss.completion_rate, 0)               AS completion_rate,
         ROUND(COALESCE(ss.revenue, 0) * sp.commission_rate / 100, 2) AS commission_amount
    FROM staff_profiles sp
    LEFT JOIN staff_stats   ss ON ss.sp_id = sp.id
    LEFT JOIN staff_ratings sr ON sr.sp_id = sp.id
   WHERE sp.business_id = p_business_id
     AND sp.is_active = true
   ORDER BY revenue DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- ═══════════════════════════════════════════════════════════════════════════
-- 6) get_supplier_spend
--    Total spend and order count per supplier for a date range.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_supplier_spend(
  p_business_id uuid,
  p_start_date  date,
  p_end_date    date
)
RETURNS TABLE (
  supplier_id   uuid,
  supplier_name text,
  total_spent   numeric,
  order_count   int
)
AS $$
BEGIN
  RETURN QUERY
  SELECT s.id                           AS supplier_id,
         s.name                         AS supplier_name,
         COALESCE(SUM(e.amount), 0)     AS total_spent,
         COUNT(DISTINCT so.id)::int     AS order_count
    FROM suppliers s
    LEFT JOIN expenses e
      ON e.supplier_id = s.id
     AND e.business_id = p_business_id
     AND e.date BETWEEN p_start_date AND p_end_date
    LEFT JOIN supplier_orders so
      ON so.supplier_id = s.id
     AND so.business_id = p_business_id
     AND so.ordered_at::date BETWEEN p_start_date AND p_end_date
   WHERE s.business_id = p_business_id
     AND s.is_active = true
   GROUP BY s.id, s.name
   ORDER BY total_spent DESC;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- ═══════════════════════════════════════════════════════════════════════════
-- 7) get_owner_dashboard_kpis
--    Single RPC returning the full owner dashboard payload.
--    Uses CTEs to minimise round-trips.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_owner_dashboard_kpis(
  p_business_id uuid,
  p_date        date DEFAULT CURRENT_DATE
)
RETURNS jsonb
AS $$
DECLARE
  v_week_start  date;
  v_month_start date;
  v_30d_start   date;
  v_result      jsonb;
BEGIN
  v_week_start  := date_trunc('week', p_date)::date;
  v_month_start := date_trunc('month', p_date)::date;
  v_30d_start   := p_date - 30;

  WITH today_appts AS (
    SELECT a.id, a.status, a.price, a.is_walk_in
      FROM appointments a
     WHERE a.business_id = p_business_id
       AND a.starts_at::date = p_date
  ),
  today_stats AS (
    SELECT COUNT(*)::int                                               AS total,
           COUNT(*) FILTER (WHERE status IN ('pending','confirmed'))::int AS remaining,
           COUNT(*) FILTER (WHERE status = 'completed')::int           AS completed,
           COUNT(*) FILTER (WHERE status = 'cancelled')::int           AS cancelled,
           COUNT(*) FILTER (WHERE is_walk_in)::int                     AS walk_ins,
           COALESCE(SUM(price) FILTER (WHERE status = 'completed'), 0) AS revenue
      FROM today_appts
  ),
  week_stats AS (
    SELECT COUNT(*)::int                                               AS total,
           COUNT(*) FILTER (WHERE status = 'completed')::int           AS completed,
           COUNT(*) FILTER (WHERE status = 'cancelled')::int           AS cancelled,
           COALESCE(SUM(price) FILTER (WHERE status = 'completed'), 0) AS revenue
      FROM appointments
     WHERE business_id = p_business_id
       AND starts_at::date BETWEEN v_week_start AND p_date
  ),
  month_stats AS (
    SELECT COUNT(*)::int                                               AS total,
           COUNT(*) FILTER (WHERE status = 'completed')::int           AS completed,
           COALESCE(SUM(price) FILTER (WHERE status = 'completed'), 0) AS revenue
      FROM appointments
     WHERE business_id = p_business_id
       AND starts_at::date BETWEEN v_month_start AND p_date
  ),
  active_clients AS (
    SELECT COUNT(DISTINCT client_id)::int AS total
      FROM appointments
     WHERE business_id = p_business_id
       AND status = 'completed'
       AND starts_at::date >= v_30d_start
  ),
  avg_rating AS (
    SELECT ROUND(AVG(r.rating), 2) AS val
      FROM reviews r
     WHERE r.business_id = p_business_id
       AND r.is_public = true
  ),
  completion_30d AS (
    SELECT CASE
             WHEN COUNT(*) FILTER (WHERE status IN ('completed','cancelled','no_show')) > 0
             THEN ROUND(
               COUNT(*) FILTER (WHERE status = 'completed')::numeric
               / COUNT(*) FILTER (WHERE status IN ('completed','cancelled','no_show'))
             , 4)
             ELSE 0
           END AS rate
      FROM appointments
     WHERE business_id = p_business_id
       AND starts_at::date >= v_30d_start
  ),
  upcoming_today AS (
    SELECT jsonb_agg(jsonb_build_object(
             'id',                a.id,
             'starts_at',         a.starts_at,
             'ends_at',           a.ends_at,
             'status',            a.status,
             'booking_reference', a.booking_reference,
             'client_name',       COALESCE(c.first_name || ' ' || c.last_name, 'Walk-in'),
             'service_name',      s.name,
             'staff_name',        sp.display_name,
             'price',             a.price
           ) ORDER BY a.starts_at) AS val
      FROM appointments a
      LEFT JOIN clients        c  ON c.id  = a.client_id
      LEFT JOIN services       s  ON s.id  = a.service_id
      LEFT JOIN staff_profiles sp ON sp.id = a.staff_profile_id
     WHERE a.business_id = p_business_id
       AND a.starts_at::date = p_date
       AND a.status IN ('pending', 'confirmed', 'in_progress')
  ),
  top_services AS (
    SELECT jsonb_agg(jsonb_build_object(
             'service_id',   sub.service_id,
             'service_name', sub.service_name,
             'count',        sub.cnt,
             'revenue',      sub.rev
           ) ORDER BY sub.rev DESC) AS val
      FROM (
        SELECT s.id   AS service_id,
               s.name AS service_name,
               COUNT(*)::int AS cnt,
               COALESCE(SUM(a.price), 0) AS rev
          FROM appointments a
          JOIN services s ON s.id = a.service_id
         WHERE a.business_id = p_business_id
           AND a.starts_at::date >= v_30d_start
           AND a.status = 'completed'
         GROUP BY s.id, s.name
         ORDER BY rev DESC
         LIMIT 5
      ) sub
  ),
  busy_hours AS (
    SELECT jsonb_agg(jsonb_build_object(
             'hour', sub.hr,
             'count', sub.cnt
           ) ORDER BY sub.cnt DESC) AS val
      FROM (
        SELECT EXTRACT(HOUR FROM a.starts_at)::int AS hr,
               COUNT(*)::int AS cnt
          FROM appointments a
         WHERE a.business_id = p_business_id
           AND a.starts_at::date >= v_30d_start
           AND a.status IN ('completed', 'confirmed')
         GROUP BY 1
         ORDER BY cnt DESC
         LIMIT 12
      ) sub
  ),
  staff_on_today AS (
    SELECT jsonb_agg(jsonb_build_object(
             'staff_profile_id', sp.id,
             'display_name',     sp.display_name,
             'avatar_url',       sp.avatar_url,
             'calendar_color',   sp.calendar_color
           ) ORDER BY sp.display_name) AS val
      FROM staff_profiles sp
      JOIN staff_working_hours wh
        ON wh.staff_profile_id = sp.id
       AND wh.day_of_week = EXTRACT(DOW FROM p_date)::int
       AND wh.is_working = true
     WHERE sp.business_id = p_business_id
       AND sp.is_active = true
  )
  SELECT jsonb_build_object(
    'today', jsonb_build_object(
      'total',      (SELECT total     FROM today_stats),
      'remaining',  (SELECT remaining FROM today_stats),
      'completed',  (SELECT completed FROM today_stats),
      'cancelled',  (SELECT cancelled FROM today_stats),
      'walk_ins',   (SELECT walk_ins  FROM today_stats),
      'revenue',    (SELECT revenue   FROM today_stats)
    ),
    'this_week', jsonb_build_object(
      'total',     (SELECT total     FROM week_stats),
      'completed', (SELECT completed FROM week_stats),
      'cancelled', (SELECT cancelled FROM week_stats),
      'revenue',   (SELECT revenue   FROM week_stats)
    ),
    'this_month', jsonb_build_object(
      'total',     (SELECT total     FROM month_stats),
      'completed', (SELECT completed FROM month_stats),
      'revenue',   (SELECT revenue   FROM month_stats)
    ),
    'active_clients_total', (SELECT total FROM active_clients),
    'avg_rating',           COALESCE((SELECT val FROM avg_rating), 0),
    'completion_rate_30d',  (SELECT rate FROM completion_30d),
    'upcoming_today',       COALESCE((SELECT val FROM upcoming_today), '[]'::jsonb),
    'top_services_30d',     COALESCE((SELECT val FROM top_services),   '[]'::jsonb),
    'busy_hours_30d',       COALESCE((SELECT val FROM busy_hours),     '[]'::jsonb),
    'staff_on_today',       COALESCE((SELECT val FROM staff_on_today), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
