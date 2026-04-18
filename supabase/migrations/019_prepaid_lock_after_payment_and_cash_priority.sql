-- ---------------------------------------------------------------------------
-- 019_prepaid_lock_after_payment_and_cash_priority.sql
-- Rules:
-- 1) Prepaid bookings (card) lock slots only after payment is successful.
-- 2) Pay-at-salon reservations (cash) lock slots for pay-later requests.
-- 3) Prepaid requests can still take a slot currently reserved by cash.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS get_available_slots(uuid, uuid, uuid, date);
DROP FUNCTION IF EXISTS get_available_slots(uuid, uuid, uuid, date, text);
CREATE OR REPLACE FUNCTION get_available_slots(
    p_business_id uuid,
    p_service_id uuid,
    p_staff_id uuid DEFAULT NULL,
    p_date date DEFAULT CURRENT_DATE,
    p_request_is_prepaid boolean DEFAULT false
  ) RETURNS TABLE (
    slot_time time,
    staff_profile_id uuid,
    staff_name text,
    custom_price numeric
  ) AS $$
DECLARE v_duration int;
v_slot_interval int;
v_lead_hours int;
v_future_days int;
v_earliest_time timestamptz;
v_max_date date;
BEGIN
SELECT s.duration_minutes INTO v_duration
FROM services s
WHERE s.id = p_service_id
  AND s.business_id = p_business_id
  AND s.is_active = true;
IF v_duration IS NULL THEN RETURN;
END IF;
SELECT COALESCE(bs.slot_duration_minutes, 30),
  COALESCE(bs.booking_lead_time_hours, 2),
  COALESCE(bs.booking_future_days, 60) INTO v_slot_interval,
  v_lead_hours,
  v_future_days
FROM business_settings bs
WHERE bs.business_id = p_business_id;
v_slot_interval := COALESCE(v_slot_interval, 30);
v_lead_hours := COALESCE(v_lead_hours, 2);
v_future_days := COALESCE(v_future_days, 60);
v_max_date := CURRENT_DATE + v_future_days;
IF p_date > v_max_date THEN RETURN;
END IF;
v_earliest_time := now() + (v_lead_hours || ' hours')::interval;
RETURN QUERY WITH eligible_staff AS (
  SELECT sp.id AS sp_id,
    sp.display_name,
    COALESCE(ss.custom_price, srv.price) AS eff_price
  FROM staff_services ss
    JOIN staff_profiles sp ON sp.id = ss.staff_profile_id
    JOIN services srv ON srv.id = ss.service_id
  WHERE ss.service_id = p_service_id
    AND sp.business_id = p_business_id
    AND sp.is_active = true
    AND (
      p_staff_id IS NULL
      OR sp.id = p_staff_id
    )
),
staff_hours AS (
  SELECT es.sp_id,
    es.display_name,
    es.eff_price,
    wh.start_time AS wh_start,
    wh.end_time AS wh_end
  FROM eligible_staff es
    JOIN staff_working_hours wh ON wh.staff_profile_id = es.sp_id
    AND wh.day_of_week = EXTRACT(
      DOW
      FROM p_date
    )::int
    AND wh.is_working = true
),
slot_series AS (
  SELECT sh.sp_id,
    sh.display_name,
    sh.eff_price,
    gs AS slot_start
  FROM staff_hours sh,
    generate_series(
      (
        p_date::text || ' ' || sh.wh_start::text || ' +00'
      )::timestamptz,
      (p_date::text || ' ' || sh.wh_end::text || ' +00')::timestamptz - (v_duration || ' minutes')::interval,
      (v_slot_interval || ' minutes')::interval
    ) gs
),
booked AS (
  SELECT a.staff_profile_id AS sp_id,
    a.starts_at,
    a.ends_at
  FROM appointments a
    LEFT JOIN payments p ON p.appointment_id = a.id
  WHERE a.business_id = p_business_id
    AND a.starts_at::date = p_date
    AND a.status NOT IN ('cancelled', 'no_show')
    AND (
      -- Pay-at-salon (cash) reservations block only for pay-later requests.
      (
        p.method::text = 'cash'
        AND NOT p_request_is_prepaid
      )
      OR -- Card bookings block only once payment has succeeded (or appointment confirmed).
      (
        p.method::text <> 'cash'
        AND (
          p.status::text IN ('paid', 'succeeded')
          OR a.status = 'confirmed'
        )
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
SELECT DISTINCT (ss.slot_start AT TIME ZONE 'UTC')::time AS slot_time,
  ss.sp_id AS staff_profile_id,
  ss.display_name AS staff_name,
  ss.eff_price AS custom_price
FROM slot_series ss
WHERE NOT EXISTS (
    SELECT 1
    FROM booked b
    WHERE b.sp_id = ss.sp_id
      AND ss.slot_start < b.ends_at
      AND (
        ss.slot_start + (v_duration || ' minutes')::interval
      ) > b.starts_at
  )
  AND NOT EXISTS (
    SELECT 1
    FROM time_off toff
    WHERE toff.sp_id = ss.sp_id
      AND ss.slot_start < toff.ends_at
      AND (
        ss.slot_start + (v_duration || ' minutes')::interval
      ) > toff.starts_at
  )
  AND ss.slot_start >= v_earliest_time
ORDER BY slot_time,
  ss.sp_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public;
