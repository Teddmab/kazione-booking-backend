-- ---------------------------------------------------------------------------
-- 011_availability_functions.sql  -  get_available_slots, get_business_calendar
-- ---------------------------------------------------------------------------

-- 1) get_available_slots
--    Returns bookable 30-min time slots for a given service + date.
--    Optionally filtered to a single staff member (p_staff_id).
--
--    Slot generation logic:
--      a. Resolve service duration
--      b. Collect active staff who can perform the service
--      c. Read business_settings for lead-time and future-day limits
--      d. For each staff member, read working hours for the target day-of-week
--      e. Generate 30-min slots from start_time to (end_time - duration)
--      f. Exclude slots that overlap existing non-cancelled appointments
--      g. Exclude slots covered by staff_time_off
--      h. Exclude slots that fall within booking_lead_time_hours of NOW()
--      i. Return empty if p_date exceeds booking_future_days
--      j. Return sorted, distinct rows with staff info and price

CREATE OR REPLACE FUNCTION get_available_slots(
  p_business_id uuid,
  p_service_id  uuid,
  p_staff_id    uuid DEFAULT NULL,
  p_date        date DEFAULT CURRENT_DATE
)
RETURNS TABLE (
  slot_time        time,
  staff_profile_id uuid,
  staff_name       text,
  custom_price     numeric
)
AS $$
DECLARE
  v_duration       int;
  v_slot_interval  int;
  v_lead_hours     int;
  v_future_days    int;
  v_earliest_time  timestamptz;
  v_max_date       date;
BEGIN
  -- ── a. Resolve service duration ──────────────────────────────────────────
  SELECT s.duration_minutes
    INTO v_duration
    FROM services s
   WHERE s.id = p_service_id
     AND s.business_id = p_business_id
     AND s.is_active = true;

  IF v_duration IS NULL THEN
    RETURN;  -- service not found or inactive
  END IF;

  -- ── c. Read business settings ───────────────────────────────────────────
  SELECT COALESCE(bs.slot_duration_minutes, 30),
         COALESCE(bs.booking_lead_time_hours, 2),
         COALESCE(bs.booking_future_days, 60)
    INTO v_slot_interval, v_lead_hours, v_future_days
    FROM business_settings bs
   WHERE bs.business_id = p_business_id;

  -- Defaults when no settings row exists
  v_slot_interval := COALESCE(v_slot_interval, 30);
  v_lead_hours    := COALESCE(v_lead_hours, 2);
  v_future_days   := COALESCE(v_future_days, 60);

  -- ── i. Future-day limit ─────────────────────────────────────────────────
  v_max_date := CURRENT_DATE + v_future_days;
  IF p_date > v_max_date THEN
    RETURN;  -- date is beyond the allowed booking window
  END IF;

  -- ── h. Lead-time cutoff ─────────────────────────────────────────────────
  v_earliest_time := now() + (v_lead_hours || ' hours')::interval;

  -- ── b,d,e,f,g,j. Generate & filter slots ───────────────────────────────
  RETURN QUERY
  WITH eligible_staff AS (
    -- b. Active staff who can do this service, optionally filtered
    SELECT sp.id   AS sp_id,
           sp.display_name,
           COALESCE(ss.custom_price, srv.price) AS eff_price
      FROM staff_services ss
      JOIN staff_profiles sp ON sp.id = ss.staff_profile_id
      JOIN services       srv ON srv.id = ss.service_id
     WHERE ss.service_id   = p_service_id
       AND sp.business_id  = p_business_id
       AND sp.is_active    = true
       AND (p_staff_id IS NULL OR sp.id = p_staff_id)
  ),
  staff_hours AS (
    -- d. Working hours for the target day-of-week
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
    -- e. Generate slots at v_slot_interval increments
    SELECT sh.sp_id,
           sh.display_name,
           sh.eff_price,
           gs::time AS s_time
      FROM staff_hours sh,
           generate_series(
             sh.wh_start,
             sh.wh_end - (v_duration || ' minutes')::interval,
             (v_slot_interval || ' minutes')::interval
           ) gs
  ),
  booked AS (
    -- f. Existing appointments that block slots
    SELECT a.staff_profile_id AS sp_id,
           a.starts_at,
           a.ends_at
      FROM appointments a
     WHERE a.business_id = p_business_id
       AND a.starts_at::date = p_date
       AND a.status NOT IN ('cancelled', 'no_show')
  ),
  time_off AS (
    -- g. Staff time-off ranges covering p_date
    SELECT sto.staff_profile_id AS sp_id,
           sto.starts_at,
           sto.ends_at
      FROM staff_time_off sto
     WHERE sto.business_id = p_business_id
       AND sto.starts_at < (p_date + 1)::timestamptz
       AND sto.ends_at   > p_date::timestamptz
  )
  SELECT DISTINCT
         ss.s_time                     AS slot_time,
         ss.sp_id                      AS staff_profile_id,
         ss.display_name               AS staff_name,
         ss.eff_price                  AS custom_price
    FROM slot_series ss
   WHERE
     -- f. No overlapping appointment
     NOT EXISTS (
       SELECT 1
         FROM booked b
        WHERE b.sp_id = ss.sp_id
          AND (p_date + ss.s_time)                                    < b.ends_at
          AND (p_date + ss.s_time + (v_duration || ' minutes')::interval) > b.starts_at
     )
     -- g. No time-off overlap
     AND NOT EXISTS (
       SELECT 1
         FROM time_off toff
        WHERE toff.sp_id = ss.sp_id
          AND (p_date + ss.s_time)                                    < toff.ends_at
          AND (p_date + ss.s_time + (v_duration || ' minutes')::interval) > toff.starts_at
     )
     -- h. Slot must be after lead-time cutoff
     AND (p_date + ss.s_time) >= v_earliest_time
   ORDER BY ss.s_time, ss.sp_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- ---------------------------------------------------------------------------
-- 2) get_business_calendar
--    Returns appointment rows for a date range, joined with client, service,
--    and staff info. Used by the owner/receptionist calendar view.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_business_calendar(
  p_business_id uuid,
  p_start_date  date,
  p_end_date    date,
  p_staff_id    uuid DEFAULT NULL
)
RETURNS TABLE (
  appointment_id    uuid,
  starts_at         timestamptz,
  ends_at           timestamptz,
  status            appointment_status,
  booking_reference text,
  client_first_name text,
  client_last_name  text,
  service_name      text,
  staff_display_name text,
  price             numeric,
  booking_source    booking_source,
  is_walk_in        boolean
)
AS $$
BEGIN
  RETURN QUERY
  SELECT a.id              AS appointment_id,
         a.starts_at,
         a.ends_at,
         a.status,
         a.booking_reference,
         c.first_name      AS client_first_name,
         c.last_name       AS client_last_name,
         s.name            AS service_name,
         sp.display_name   AS staff_display_name,
         a.price,
         a.booking_source,
         a.is_walk_in
    FROM appointments a
    LEFT JOIN clients        c  ON c.id  = a.client_id
    LEFT JOIN services       s  ON s.id  = a.service_id
    LEFT JOIN staff_profiles sp ON sp.id = a.staff_profile_id
   WHERE a.business_id = p_business_id
     AND a.starts_at::date >= p_start_date
     AND a.starts_at::date <= p_end_date
     AND (p_staff_id IS NULL OR a.staff_profile_id = p_staff_id)
   ORDER BY a.starts_at;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
