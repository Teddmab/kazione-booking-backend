-- ─────────────────────────────────────────────────────────────────────────────
-- 090 — Fix get_available_slots 5-param: generate_series type error
--
-- Root cause: migration 086 added a 5-param get_available_slots that calls
--   generate_series(sh.wh_start, sh.wh_end - interval, interval)
-- where wh_start / wh_end are type `time without time zone` (from
-- staff_working_hours). PostgreSQL has no generate_series(time, time, interval)
-- overload → runtime error on every call → create-booking 500.
--
-- Fix: cast wh_start / wh_end to timestamptz before passing to generate_series,
-- using the same pattern as migration 049:
--   (p_date::text || ' ' || sh.wh_start::text || ' +00')::timestamptz
-- Then extract the UTC time component with (gs AT TIME ZONE 'UTC')::time.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_available_slots(
  p_business_id uuid,
  p_service_id  uuid,
  p_staff_id    uuid DEFAULT NULL,
  p_date        date DEFAULT CURRENT_DATE,
  p_min_staff   int  DEFAULT 1
)
RETURNS TABLE (
  slot_time        time,
  staff_profile_id uuid,
  staff_name       text,
  custom_price     numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_duration       int;
  v_slot_interval  int;
  v_lead_hours     int;
  v_future_days    int;
  v_earliest_time  timestamptz;
  v_max_date       date;
BEGIN
  SELECT s.duration_minutes
    INTO v_duration
    FROM services s
   WHERE s.id = p_service_id
     AND s.business_id = p_business_id
     AND s.is_active = true;

  IF v_duration IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(bs.slot_duration_minutes, 30),
         COALESCE(bs.booking_lead_time_hours, 2),
         COALESCE(bs.booking_future_days, 60)
    INTO v_slot_interval, v_lead_hours, v_future_days
    FROM business_settings bs
   WHERE bs.business_id = p_business_id;

  v_slot_interval := COALESCE(v_slot_interval, 30);
  v_lead_hours    := COALESCE(v_lead_hours, 2);
  v_future_days   := COALESCE(v_future_days, 60);

  v_max_date := CURRENT_DATE + v_future_days;
  IF p_date > v_max_date THEN
    RETURN;
  END IF;

  v_earliest_time := now() + (v_lead_hours || ' hours')::interval;

  RETURN QUERY
  WITH eligible_staff AS (
    SELECT sp.id   AS sp_id,
           sp.display_name,
           COALESCE(ss.custom_price, srv.price) AS eff_price
      FROM staff_services ss
      JOIN staff_profiles sp  ON sp.id  = ss.staff_profile_id
      JOIN services       srv ON srv.id = ss.service_id
     WHERE ss.service_id  = p_service_id
       AND sp.business_id = p_business_id
       AND sp.is_active   = true
       AND (p_staff_id IS NULL OR sp.id = p_staff_id)
  ),
  staff_hours AS (
    SELECT es.sp_id,
           es.display_name,
           es.eff_price,
           wh.start_time AS wh_start,
           wh.end_time   AS wh_end
      FROM eligible_staff es
      JOIN staff_working_hours wh
        ON wh.staff_profile_id = es.sp_id
       AND wh.day_of_week = EXTRACT(DOW FROM p_date)::int
       AND wh.is_working  = true
  ),
  slot_series AS (
    SELECT sh.sp_id,
           sh.display_name,
           sh.eff_price,
           (gs AT TIME ZONE 'UTC')::time AS s_time
      FROM staff_hours sh,
           generate_series(
             (p_date::text || ' ' || sh.wh_start::text || ' +00')::timestamptz,
             (p_date::text || ' ' || sh.wh_end::text   || ' +00')::timestamptz
               - (v_duration || ' minutes')::interval,
             (v_slot_interval || ' minutes')::interval
           ) gs
  ),
  booked AS (
    SELECT a.staff_profile_id AS sp_id,
           a.starts_at,
           a.ends_at
      FROM appointments a
     WHERE a.business_id    = p_business_id
       AND a.starts_at::date = p_date
       AND a.status NOT IN ('cancelled', 'no_show')
  ),
  time_off AS (
    SELECT sto.staff_profile_id AS sp_id,
           sto.starts_at,
           sto.ends_at
      FROM staff_time_off sto
     WHERE sto.business_id = p_business_id
       AND sto.starts_at < (p_date + 1)::timestamptz
       AND sto.ends_at   > p_date::timestamptz
  ),
  free_slots AS (
    SELECT ss.s_time, ss.sp_id, ss.display_name, ss.eff_price
      FROM slot_series ss
     WHERE
       NOT EXISTS (
         SELECT 1 FROM booked b
          WHERE b.sp_id = ss.sp_id
            AND (p_date + ss.s_time)                                        < b.ends_at
            AND (p_date + ss.s_time + (v_duration || ' minutes')::interval) > b.starts_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM time_off toff
          WHERE toff.sp_id = ss.sp_id
            AND (p_date + ss.s_time)                                        < toff.ends_at
            AND (p_date + ss.s_time + (v_duration || ' minutes')::interval) > toff.starts_at
       )
       AND (p_date + ss.s_time) >= v_earliest_time
  ),
  slot_counts AS (
    SELECT s_time, COUNT(*) AS free_count
      FROM free_slots
     GROUP BY s_time
  )
  SELECT DISTINCT
         fs.s_time        AS slot_time,
         fs.sp_id         AS staff_profile_id,
         fs.display_name  AS staff_name,
         fs.eff_price     AS custom_price
    FROM free_slots fs
    JOIN slot_counts sc ON sc.s_time = fs.s_time
   WHERE sc.free_count >= p_min_staff
   ORDER BY fs.s_time, fs.sp_id;
END;
$$;
