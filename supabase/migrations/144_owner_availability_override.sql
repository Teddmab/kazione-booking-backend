-- ─────────────────────────────────────────────────────────────────────────────
-- 144_owner_availability_override.sql
--
-- Reported: booking a new appointment from the owner dashboard shows a
-- time as unavailable the moment ANY staff member already has something
-- booked then — even though 139 already lets the owner proceed past a
-- staff/seat conflict with an explicit confirm at write time. The gap:
-- get_available_slots (the picker's data source, called by the public
-- get-availability edge function with no notion of caller identity) always
-- excludes staff-busy and over-capacity slots, for every caller alike.
-- 139/140 only ever touched the WRITE path (check_and_reserve_slot) — the
-- READ path was never taught that an owner is allowed to see (and then
-- confirm through) a slot a public customer never should.
--
-- Fix: a new p_owner_override parameter. When true (only ever passed by
-- get-availability once it verifies the caller is an authenticated owner/
-- manager of p_business_id — never for the public marketplace), staff-busy
-- and at-capacity slots are INCLUDED instead of excluded. Staff working
-- hours and time off remain hard constraints either way — those aren't
-- "conflicts to override", the staff member simply isn't working then.
--
-- Also returns has_staff_conflict / at_capacity per row so the caller can
-- show *why* a slot needs confirming, instead of the frontend re-deriving
-- that with a second guess-and-check query.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS get_available_slots(uuid, uuid, uuid, date, int);

CREATE OR REPLACE FUNCTION get_available_slots(
  p_business_id     uuid,
  p_service_id      uuid,
  p_staff_id        uuid    DEFAULT NULL,
  p_date            date    DEFAULT CURRENT_DATE,
  p_min_staff       int     DEFAULT 1,
  p_owner_override  boolean DEFAULT false
)
RETURNS TABLE (
  slot_time          time,
  staff_profile_id   uuid,
  staff_name         text,
  custom_price       numeric,
  has_staff_conflict boolean,
  at_capacity        boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_duration               int;
  v_slot_interval          int;
  v_lead_hours             int;
  v_future_days            int;
  v_earliest_time          timestamptz;
  v_max_date               date;
  v_business_tz            text;
  v_day_start_utc          timestamptz;
  v_day_end_utc            timestamptz;
  v_capacity_enforced      boolean;
  v_seat_count             int;
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
         COALESCE(bs.booking_future_days, 60),
         (bs.seat_capacity_enabled IS TRUE AND bs.seat_capacity_enforced IS TRUE
           AND EXISTS (
             SELECT 1 FROM capacity_enforcement_pilot_businesses peb
              WHERE peb.business_id = p_business_id
           )),
         bs.seat_count
    INTO v_slot_interval, v_lead_hours, v_future_days, v_capacity_enforced, v_seat_count
    FROM business_settings bs
   WHERE bs.business_id = p_business_id;

  v_slot_interval     := COALESCE(v_slot_interval, 30);
  v_lead_hours        := COALESCE(v_lead_hours, 2);
  v_future_days       := COALESCE(v_future_days, 60);
  v_capacity_enforced := COALESCE(v_capacity_enforced, false) AND v_seat_count IS NOT NULL;

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
  v_day_start_utc := (p_date::timestamp AT TIME ZONE v_business_tz);
  v_day_end_utc   := ((p_date + 1)::timestamp AT TIME ZONE v_business_tz);

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
       AND ss.status       = 'accepted'
       AND (ss.effective_date IS NULL OR ss.effective_date <= p_date)
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
             ((p_date + sh.wh_start) AT TIME ZONE v_business_tz),
             ((p_date + sh.wh_end) AT TIME ZONE v_business_tz)
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
  -- Every EXISTS/COUNT check below computed exactly once per (instant,
  -- staff) row, as plain boolean flags — filtering happens one CTE layer
  -- down so p_owner_override can choose which flags actually exclude a row
  -- instead of duplicating each subquery once per branch.
  slot_flags AS (
    SELECT ss.s_instant, ss.sp_id, ss.display_name, ss.eff_price,
           EXISTS (
             SELECT 1 FROM booked b
              WHERE b.sp_id = ss.sp_id
                AND ss.s_instant                                        < b.ends_at
                AND (ss.s_instant + (v_duration || ' minutes')::interval) > b.starts_at
           ) AS is_staff_conflict,
           EXISTS (
             SELECT 1 FROM time_off toff
              WHERE toff.sp_id = ss.sp_id
                AND ss.s_instant                                        < toff.ends_at
                AND (ss.s_instant + (v_duration || ' minutes')::interval) > toff.starts_at
           ) AS is_time_off,
           (
             v_capacity_enforced AND (
               SELECT COUNT(*)
                 FROM appointments a
                WHERE a.business_id = p_business_id
                  AND a.status NOT IN ('cancelled', 'no_show', 'completed')
                  AND a.starts_at < (ss.s_instant + (v_duration || ' minutes')::interval)
                  AND a.ends_at   > ss.s_instant
             ) >= v_seat_count
           ) AS is_at_capacity
      FROM slot_series ss
     WHERE ss.s_instant >= v_earliest_time
  ),
  -- Staff working hours / time off are hard constraints regardless of
  -- caller — the staff member simply isn't working then. Staff-busy and
  -- seat-capacity are the two conflict types 139 already lets an owner
  -- confirm past at write time, so p_owner_override includes them here
  -- instead of hiding the slot outright.
  free_slots AS (
    SELECT sf.s_instant, sf.sp_id, sf.display_name, sf.eff_price,
           sf.is_staff_conflict, sf.is_at_capacity
      FROM slot_flags sf
     WHERE NOT sf.is_time_off
       AND (p_owner_override OR NOT sf.is_staff_conflict)
       AND (p_owner_override OR NOT sf.is_at_capacity)
  ),
  slot_counts AS (
    SELECT s_instant, COUNT(*) AS free_count
      FROM free_slots
     GROUP BY s_instant
  )
  SELECT DISTINCT
         (fs.s_instant AT TIME ZONE v_business_tz)::time AS slot_time,
         fs.sp_id             AS staff_profile_id,
         fs.display_name      AS staff_name,
         fs.eff_price         AS custom_price,
         fs.is_staff_conflict AS has_staff_conflict,
         fs.is_at_capacity    AS at_capacity
    FROM free_slots fs
    JOIN slot_counts sc ON sc.s_instant = fs.s_instant
   WHERE sc.free_count >= p_min_staff
   -- ORDER BY must use the SELECT list's own expressions for SELECT DISTINCT
   -- (Postgres 42P10) — slot_time is a transformed expression (AT TIME ZONE
   -- + ::time cast), not the raw fs.s_instant/fs.sp_id columns, so order by
   -- the output aliases instead. Safe: within one calendar day, local
   -- time-of-day ordering is monotonic with the underlying instant ordering.
   ORDER BY slot_time, staff_profile_id;
END;
$$;
