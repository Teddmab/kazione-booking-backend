-- ─────────────────────────────────────────────────────────────────────────────
-- 113 — get_available_slots becomes timezone-aware (S59)
--
-- Root cause: this function has always anchored staff_working_hours (local
-- wall-clock `time` values the owner entered, e.g. "10:00"-"19:00") to UTC
-- via a hardcoded '+00' offset, then degraded the generated series to a bare
-- `time` and reconstructed `p_date + s_time` for every downstream comparison
-- (booked/time_off/lead-time). That reconstruction silently drops date-
-- rollover information for any business whose UTC offset pushes a slot
-- across the UTC calendar-date boundary, and the '+00' anchor means "10:00"
-- was never actually 10:00 in the business's own timezone unless that
-- business happens to sit at UTC+0.
--
-- Fix: look up businesses.timezone, anchor the generate_series using
-- Postgres's native `timestamp AT TIME ZONE zone` local-wall-clock→instant
-- idiom (DST-aware via Postgres's own tzdata), and carry the full
-- timestamptz instant through every CTE instead of degrading to `::time`
-- early. booked/time_off now filter by a genuine UTC day-window (computed
-- from the business's local midnight) instead of `starts_at::date = p_date`,
-- which depended on the session timezone and could miss/include rows for
-- any business whose local day doesn't align with the UTC calendar day.
-- Only the final SELECT converts back to a local-wall-clock `time` label —
-- the shape every existing caller (create-booking, get-availability,
-- reschedule-booking) already expects, so no caller changes are needed.
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
  v_business_tz    text;
  v_day_start_utc  timestamptz;
  v_day_end_utc    timestamptz;
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

  SELECT COALESCE(b.timezone, 'UTC')
    INTO v_business_tz
    FROM businesses b
   WHERE b.id = p_business_id;
  v_business_tz := COALESCE(v_business_tz, 'UTC');

  v_max_date := CURRENT_DATE + v_future_days;
  IF p_date > v_max_date THEN
    RETURN;
  END IF;

  v_earliest_time := now() + (v_lead_hours || ' hours')::interval;
  v_day_start_utc := (p_date::text || ' 00:00:00')::timestamp AT TIME ZONE v_business_tz;
  v_day_end_utc   := ((p_date + 1)::text || ' 00:00:00')::timestamp AT TIME ZONE v_business_tz;

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
           gs AS s_instant
      FROM staff_hours sh,
           generate_series(
             (p_date::text || ' ' || sh.wh_start::text)::timestamp AT TIME ZONE v_business_tz,
             (p_date::text || ' ' || sh.wh_end::text)::timestamp AT TIME ZONE v_business_tz
               - (v_duration || ' minutes')::interval,
             (v_slot_interval || ' minutes')::interval
           ) gs
  ),
  booked AS (
    SELECT a.staff_profile_id AS sp_id,
           a.starts_at,
           a.ends_at
      FROM appointments a
     WHERE a.business_id = p_business_id
       AND a.starts_at   < v_day_end_utc
       AND a.ends_at     > v_day_start_utc
       AND a.status NOT IN ('cancelled', 'no_show')
  ),
  time_off AS (
    SELECT sto.staff_profile_id AS sp_id,
           sto.starts_at,
           sto.ends_at
      FROM staff_time_off sto
     WHERE sto.business_id = p_business_id
       AND sto.starts_at   < v_day_end_utc
       AND sto.ends_at     > v_day_start_utc
  ),
  free_slots AS (
    SELECT ss.s_instant, ss.sp_id, ss.display_name, ss.eff_price
      FROM slot_series ss
     WHERE
       NOT EXISTS (
         SELECT 1 FROM booked b
          WHERE b.sp_id = ss.sp_id
            AND ss.s_instant                                        < b.ends_at
            AND (ss.s_instant + (v_duration || ' minutes')::interval) > b.starts_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM time_off toff
          WHERE toff.sp_id = ss.sp_id
            AND ss.s_instant                                        < toff.ends_at
            AND (ss.s_instant + (v_duration || ' minutes')::interval) > toff.starts_at
       )
       AND ss.s_instant >= v_earliest_time
  ),
  slot_counts AS (
    SELECT s_instant, COUNT(*) AS free_count
      FROM free_slots
     GROUP BY s_instant
  )
  SELECT DISTINCT
         (fs.s_instant AT TIME ZONE v_business_tz)::time AS slot_time,
         fs.sp_id         AS staff_profile_id,
         fs.display_name  AS staff_name,
         fs.eff_price     AS custom_price
    FROM free_slots fs
    JOIN slot_counts sc ON sc.s_instant = fs.s_instant
   WHERE sc.free_count >= p_min_staff
   ORDER BY fs.s_instant, fs.sp_id;
END;
$$;
