-- 040_buffer_in_availability_and_booking.sql
--
-- Wires services.buffer_minutes into the two functions that control scheduling:
--
-- get_available_slots:
--   * Fetches buffer_minutes for the queried service → v_buffer
--   * Slot series: shifts the working-hours end cutoff back by (duration + buffer)
--     so only slots where the whole service + cleanup fits are offered
--   * Blocked CTE: joins appointments → services to extend each booked
--     appointment's effective end by that service's buffer_minutes
--   * Overlap check: uses effective_ends_at (ends_at + buffer) from blocked CTE
--     and (slot_start + duration + buffer) for the new slot's end
--
-- create_booking_atomic:
--   * New parameter p_buffer_minutes (DEFAULT 0) — the queried service's buffer
--   * Overlap check: extends both sides (new slot's end, existing appt's end)
--     by their respective buffer minutes
--   * Stored ends_at remains starts_at + duration (no buffer) — the customer
--     sees only the actual service duration in their booking confirmation

-- ── get_available_slots ────────────────────────────────────────────────────

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
  v_buffer   int;
  v_slot_interval int;
  v_lead_hours int;
  v_future_days int;
  v_earliest_time timestamptz;
  v_max_date date;
BEGIN
  SELECT s.duration_minutes,
         COALESCE(s.buffer_minutes, 0)
    INTO v_duration, v_buffer
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
    -- End cutoff accounts for both service duration AND buffer so only slots
    -- where the full service + cleanup fits within working hours are offered.
    SELECT sh.sp_id,
           sh.display_name,
           sh.eff_price,
           sh.member_user_id,
           gs AS slot_start
      FROM staff_hours sh,
           generate_series(
             (p_date::text || ' ' || sh.wh_start::text || ' +00')::timestamptz,
             (p_date::text || ' ' || sh.wh_end::text || ' +00')::timestamptz
               - ((v_duration + v_buffer) || ' minutes')::interval,
             (v_slot_interval || ' minutes')::interval
           ) gs
  ),
  blocked AS (
    -- Extend each booked appointment's end by its own service's buffer so the
    -- cleanup window is treated as occupied for availability purposes.
    SELECT DISTINCT es.sp_id,
           a.starts_at,
           a.ends_at + (COALESCE(booked_srv.buffer_minutes, 0) || ' minutes')::interval
             AS effective_ends_at
      FROM eligible_staff es
      JOIN appointments a
        ON a.starts_at::date = p_date
      LEFT JOIN services booked_srv
        ON booked_srv.id = a.service_id
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
              AND ss.slot_start < b.effective_ends_at
              AND (ss.slot_start + ((v_duration + v_buffer) || ' minutes')::interval) > b.starts_at
         )
     AND NOT EXISTS (
           SELECT 1
             FROM time_off toff
            WHERE toff.sp_id = ss.sp_id
              AND ss.slot_start < toff.ends_at
              AND (ss.slot_start + ((v_duration + v_buffer) || ' minutes')::interval) > toff.starts_at
         )
     AND ss.slot_start >= v_earliest_time
   ORDER BY slot_time, ss.sp_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public;


-- ── create_booking_atomic ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION create_booking_atomic(
  p_business_id       uuid,
  p_service_id        uuid,
  p_staff_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,   -- starts_at + duration (no buffer; stored as-is)
  p_buffer_minutes    int DEFAULT 0, -- service buffer; extends the conflict window
  p_client_id         uuid,
  p_booking_reference text,
  p_price             numeric,
  p_deposit_amount    numeric,
  p_booking_source    text,
  p_is_walk_in        boolean,
  p_notes             text,
  p_payment_method    text,
  p_payment_status    text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_appointment_id uuid;
  v_slot_available boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_business_id::text || p_staff_id::text || p_starts_at::text)
  );

  -- Any non-cancelled appointment whose effective zone (ends_at + its service's
  -- buffer) overlaps with the new slot's effective zone (ends_at + p_buffer)
  -- blocks the slot.
  SELECT COUNT(*) = 0 INTO v_slot_available
    FROM appointments a
    LEFT JOIN services booked_srv ON booked_srv.id = a.service_id
   WHERE a.business_id      = p_business_id
     AND a.staff_profile_id = p_staff_id
     AND a.status NOT IN ('cancelled', 'no_show')
     AND a.starts_at < (p_ends_at + (p_buffer_minutes || ' minutes')::interval)
     AND (a.ends_at + (COALESCE(booked_srv.buffer_minutes, 0) || ' minutes')::interval) > p_starts_at;

  IF NOT v_slot_available THEN
    RAISE EXCEPTION 'SLOT_TAKEN: The selected time slot is no longer available';
  END IF;

  INSERT INTO appointments (
    business_id,
    service_id,
    staff_profile_id,
    starts_at,
    ends_at,
    duration_minutes,
    client_id,
    status,
    booking_reference,
    price,
    deposit_amount,
    booking_source,
    is_walk_in,
    notes
  ) VALUES (
    p_business_id,
    p_service_id,
    p_staff_id,
    p_starts_at,
    p_ends_at,
    EXTRACT(EPOCH FROM (p_ends_at - p_starts_at))::int / 60,
    p_client_id,
    'pending',
    p_booking_reference,
    p_price,
    p_deposit_amount,
    p_booking_source::booking_source,
    p_is_walk_in,
    p_notes
  ) RETURNING id INTO v_appointment_id;

  RETURN v_appointment_id;
END;
$$;
