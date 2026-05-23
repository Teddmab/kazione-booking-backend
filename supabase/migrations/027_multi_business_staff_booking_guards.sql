-- ---------------------------------------------------------------------------
-- 027_multi_business_staff_booking_guards.sql
--
-- Goal:
--   1) Allow a single human staff member (same auth user) to work in multiple
--      businesses while preventing cross-business double-booking.
--   2) Keep get_available_slots accurate by blocking times already booked in
--      any business for the same linked user.
-- ---------------------------------------------------------------------------

-- Useful for overlap checks across businesses.
CREATE INDEX IF NOT EXISTS idx_appointments_staff_time_range
  ON appointments(staff_profile_id, starts_at, ends_at);

-- Reject overlapping appointments for the same human staff member.
-- We always block overlaps for the same staff_profile_id.
-- If the profile is linked to a business_member/user, we also block overlaps
-- on any other staff_profile mapped to the same user_id (cross-business).
CREATE OR REPLACE FUNCTION prevent_staff_double_bookings()
RETURNS trigger AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF NEW.staff_profile_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('cancelled', 'no_show') THEN
    RETURN NEW;
  END IF;

  IF NEW.ends_at <= NEW.starts_at THEN
    RAISE EXCEPTION 'INVALID_APPOINTMENT_RANGE'
      USING ERRCODE = '22007',
            DETAIL = 'ends_at must be greater than starts_at';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM appointments a
    WHERE a.staff_profile_id = NEW.staff_profile_id
      AND a.status NOT IN ('cancelled', 'no_show')
      AND (TG_OP = 'INSERT' OR a.id <> NEW.id)
      AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'STAFF_DOUBLE_BOOKED'
      USING ERRCODE = '23P01',
            DETAIL = 'Overlapping appointment exists for this staff profile';
  END IF;

  SELECT bm.user_id
    INTO v_user_id
    FROM staff_profiles sp
    JOIN business_members bm ON bm.id = sp.business_member_id
   WHERE sp.id = NEW.staff_profile_id;

  IF v_user_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM appointments a
    JOIN staff_profiles sp2 ON sp2.id = a.staff_profile_id
    JOIN business_members bm2 ON bm2.id = sp2.business_member_id
    WHERE bm2.user_id = v_user_id
      AND a.status NOT IN ('cancelled', 'no_show')
      AND (TG_OP = 'INSERT' OR a.id <> NEW.id)
      AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'STAFF_DOUBLE_BOOKED'
      USING ERRCODE = '23P01',
            DETAIL = 'Overlapping appointment exists in another business for this staff member';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_prevent_staff_double_bookings ON appointments;
CREATE TRIGGER trg_prevent_staff_double_bookings
  BEFORE INSERT OR UPDATE OF staff_profile_id, starts_at, ends_at, status
  ON appointments
  FOR EACH ROW
  EXECUTE FUNCTION prevent_staff_double_bookings();

-- Keep availability aware of cross-business occupancy for linked users.
DROP FUNCTION IF EXISTS get_available_slots(uuid, uuid, uuid, date);
DROP FUNCTION IF EXISTS get_available_slots(uuid, uuid, uuid, date, text);
DROP FUNCTION IF EXISTS get_available_slots(uuid, uuid, uuid, date, boolean);
CREATE OR REPLACE FUNCTION get_available_slots(
    p_business_id uuid,
    p_service_id uuid,
    p_staff_id uuid DEFAULT NULL,
    p_date date DEFAULT CURRENT_DATE
  ) RETURNS TABLE (
    slot_time time,
    staff_profile_id uuid,
    staff_name text,
    custom_price numeric
  ) AS $$
DECLARE
  v_duration int;
  v_slot_interval int;
  v_lead_hours int;
  v_future_days int;
  v_earliest_time timestamptz;
  v_max_date date;
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
  v_lead_hours := COALESCE(v_lead_hours, 2);
  v_future_days := COALESCE(v_future_days, 60);

  v_max_date := CURRENT_DATE + v_future_days;
  IF p_date > v_max_date THEN
    RETURN;
  END IF;

  v_earliest_time := now() + (v_lead_hours || ' hours')::interval;

  RETURN QUERY
  WITH eligible_staff AS (
    SELECT sp.id AS sp_id,
           sp.display_name,
           COALESCE(ss.custom_price, srv.price) AS eff_price,
           bm.user_id AS member_user_id
      FROM staff_services ss
      JOIN staff_profiles sp ON sp.id = ss.staff_profile_id
      JOIN services srv ON srv.id = ss.service_id
      LEFT JOIN business_members bm ON bm.id = sp.business_member_id
     WHERE ss.service_id = p_service_id
       AND sp.business_id = p_business_id
       AND sp.is_active = true
       AND (p_staff_id IS NULL OR sp.id = p_staff_id)
  ),
  staff_hours AS (
    SELECT es.sp_id,
           es.display_name,
           es.eff_price,
           es.member_user_id,
           wh.start_time AS wh_start,
           wh.end_time AS wh_end
      FROM eligible_staff es
      JOIN staff_working_hours wh
        ON wh.staff_profile_id = es.sp_id
       AND wh.day_of_week = EXTRACT(DOW FROM p_date)::int
       AND wh.is_working = true
  ),
  slot_series AS (
    SELECT sh.sp_id,
           sh.display_name,
           sh.eff_price,
           sh.member_user_id,
           gs AS slot_start
      FROM staff_hours sh,
           generate_series(
             (p_date::text || ' ' || sh.wh_start::text || ' +00')::timestamptz,
             (p_date::text || ' ' || sh.wh_end::text || ' +00')::timestamptz - (v_duration || ' minutes')::interval,
             (v_slot_interval || ' minutes')::interval
           ) gs
  ),
  blocked AS (
    SELECT DISTINCT es.sp_id,
           a.starts_at,
           a.ends_at
      FROM eligible_staff es
      JOIN appointments a
        ON a.starts_at::date = p_date
      LEFT JOIN staff_profiles booked_sp
        ON booked_sp.id = a.staff_profile_id
      LEFT JOIN business_members booked_bm
        ON booked_bm.id = booked_sp.business_member_id
      LEFT JOIN payments p
        ON p.appointment_id = a.id
     WHERE a.status NOT IN ('cancelled', 'no_show')
       AND (
         a.staff_profile_id = es.sp_id
         OR (
           es.member_user_id IS NOT NULL
           AND booked_bm.user_id = es.member_user_id
         )
       )
       AND (
         a.status = 'confirmed'
         OR p.status::text IN ('paid', 'succeeded')
         OR (
           p.method::text <> 'cash'
           AND p.status::text = 'pending'
           AND a.created_at > now() - interval '30 minutes'
         )
       )
  ),
  time_off AS (
    SELECT sto.staff_profile_id AS sp_id,
           sto.starts_at,
           sto.ends_at
      FROM staff_time_off sto
     WHERE sto.business_id = p_business_id
       AND sto.starts_at < (p_date + 1)::timestamptz
       AND sto.ends_at > p_date::timestamptz
  )
  SELECT DISTINCT
         (ss.slot_start AT TIME ZONE 'UTC')::time AS slot_time,
         ss.sp_id AS staff_profile_id,
         ss.display_name AS staff_name,
         ss.eff_price AS custom_price
    FROM slot_series ss
   WHERE NOT EXISTS (
           SELECT 1
             FROM blocked b
            WHERE b.sp_id = ss.sp_id
              AND ss.slot_start < b.ends_at
              AND (ss.slot_start + (v_duration || ' minutes')::interval) > b.starts_at
         )
     AND NOT EXISTS (
           SELECT 1
             FROM time_off toff
            WHERE toff.sp_id = ss.sp_id
              AND ss.slot_start < toff.ends_at
              AND (ss.slot_start + (v_duration || ' minutes')::interval) > toff.starts_at
         )
     AND ss.slot_start >= v_earliest_time
   ORDER BY slot_time, ss.sp_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public;
