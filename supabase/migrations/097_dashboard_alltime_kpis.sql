-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 097 — add all-time totals to get_owner_dashboard_kpis
-- ─────────────────────────────────────────────────────────────────────────────
-- Returns a new "alltime" key in the JSON response:
--   { revenue, appointments, unique_clients }
-- Also adds commission_total_30d so the FinancePanel can show commission spent.
-- ─────────────────────────────────────────────────────────────────────────────

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
       AND a.deleted_at IS NULL
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
       AND deleted_at IS NULL
  ),
  month_stats AS (
    SELECT COUNT(*)::int                                               AS total,
           COUNT(*) FILTER (WHERE status = 'completed')::int           AS completed,
           COALESCE(SUM(price) FILTER (WHERE status = 'completed'), 0) AS revenue
      FROM appointments
     WHERE business_id = p_business_id
       AND starts_at::date BETWEEN v_month_start AND p_date
       AND deleted_at IS NULL
  ),
  alltime_stats AS (
    SELECT COUNT(*)::int                                               AS appointments,
           COUNT(*) FILTER (WHERE status = 'completed')::int           AS completed,
           COALESCE(SUM(price) FILTER (WHERE status = 'completed'), 0) AS revenue,
           COUNT(DISTINCT client_id)::int                              AS unique_clients
      FROM appointments
     WHERE business_id = p_business_id
       AND deleted_at IS NULL
  ),
  active_clients AS (
    SELECT COUNT(DISTINCT client_id)::int AS total
      FROM appointments
     WHERE business_id = p_business_id
       AND status = 'completed'
       AND starts_at::date >= v_30d_start
       AND deleted_at IS NULL
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
       AND deleted_at IS NULL
  ),
  commission_30d AS (
    SELECT COALESCE(
      SUM(a.price * sp.commission_rate / 100.0) FILTER (WHERE a.status = 'completed'),
      0
    ) AS total
      FROM appointments a
      JOIN staff_profiles sp ON sp.id = a.staff_profile_id
     WHERE a.business_id = p_business_id
       AND a.starts_at::date BETWEEN v_month_start AND p_date
       AND a.deleted_at IS NULL
       AND sp.commission_rate > 0
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
       AND a.deleted_at IS NULL
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
           AND a.deleted_at IS NULL
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
           AND a.deleted_at IS NULL
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
    'alltime', jsonb_build_object(
      'appointments',    (SELECT appointments   FROM alltime_stats),
      'completed',       (SELECT completed      FROM alltime_stats),
      'revenue',         (SELECT revenue        FROM alltime_stats),
      'unique_clients',  (SELECT unique_clients FROM alltime_stats)
    ),
    'commission_mtd',           COALESCE((SELECT total FROM commission_30d), 0),
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
