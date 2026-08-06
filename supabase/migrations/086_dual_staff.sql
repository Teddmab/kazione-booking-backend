-- ---------------------------------------------------------------------------
-- 086_dual_staff.sql  -  S32: Dual Staff Assignment
-- ---------------------------------------------------------------------------
-- Allows services to require two staff members simultaneously.
-- Primary earns split_pct% of total commission; secondary earns (100-split_pct)%.
-- Commission split is snapshotted at booking time so retro changes don't affect
-- historical payouts.
-- ---------------------------------------------------------------------------

-- ── 1. Services ──────────────────────────────────────────────────────────────

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS requires_two_staff  boolean      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS commission_split_pct numeric(5,2) NOT NULL DEFAULT 50.00
    CONSTRAINT chk_svc_commission_split
      CHECK (commission_split_pct BETWEEN 0 AND 100);

-- ── 2. Appointments ──────────────────────────────────────────────────────────

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS staff_profile_id_2  uuid
    REFERENCES staff_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commission_split_pct numeric(5,2)
    CONSTRAINT chk_appt_commission_split
      CHECK (commission_split_pct IS NULL OR commission_split_pct BETWEEN 0 AND 100);

CREATE INDEX IF NOT EXISTS idx_appt_staff_profile_id_2
  ON appointments(business_id, staff_profile_id_2)
  WHERE staff_profile_id_2 IS NOT NULL;

-- ── 3. Update create_booking_atomic: accept second staff params ──────────────

CREATE OR REPLACE FUNCTION create_booking_atomic(
  p_business_id          uuid,
  p_service_id           uuid,
  p_staff_id             uuid,
  p_starts_at            timestamptz,
  p_ends_at              timestamptz,
  p_buffer_minutes       int,
  p_client_id            uuid,
  p_booking_reference    text,
  p_price                numeric,
  p_deposit_amount       numeric,
  p_booking_source       text,
  p_is_walk_in           boolean,
  p_notes                text,
  p_payment_method       text,
  p_payment_status       text,
  p_staff_id_2           uuid    DEFAULT NULL,
  p_commission_split_pct numeric DEFAULT NULL
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

  SELECT COUNT(*) = 0 INTO v_slot_available
    FROM appointments a
    LEFT JOIN services booked_srv ON booked_srv.id = a.service_id
   WHERE a.business_id      = p_business_id
     AND a.staff_profile_id = p_staff_id
     AND a.status NOT IN ('cancelled', 'no_show')
     AND a.starts_at < (p_ends_at   + (p_buffer_minutes || ' minutes')::interval)
     AND (a.ends_at  + (COALESCE(booked_srv.buffer_minutes, 0) || ' minutes')::interval) > p_starts_at
     AND (
       a.status = 'confirmed'
       OR EXISTS (
         SELECT 1 FROM payments p2
          WHERE p2.appointment_id = a.id
            AND p2.status::text IN ('paid', 'succeeded')
       )
       OR EXISTS (
         SELECT 1 FROM payments p2
          WHERE p2.appointment_id = a.id
            AND p2.method::text = 'later'
       )
       OR EXISTS (
         SELECT 1 FROM payments p2
          WHERE p2.appointment_id = a.id
            AND p2.status::text  = 'pending'
            AND a.created_at     > now() - interval '30 minutes'
       )
       OR a.created_at > now() - interval '30 seconds'
     );

  IF NOT v_slot_available THEN
    RAISE EXCEPTION 'SLOT_TAKEN: The selected time slot is no longer available';
  END IF;

  INSERT INTO appointments (
    business_id, service_id, staff_profile_id,
    starts_at, ends_at, duration_minutes,
    client_id, status, booking_reference,
    price, deposit_amount, booking_source, is_walk_in, notes,
    staff_profile_id_2, commission_split_pct
  ) VALUES (
    p_business_id, p_service_id, p_staff_id,
    p_starts_at, p_ends_at,
    EXTRACT(EPOCH FROM (p_ends_at - p_starts_at))::int / 60,
    p_client_id, 'pending', p_booking_reference,
    p_price, p_deposit_amount,
    p_booking_source::booking_source, p_is_walk_in, p_notes,
    p_staff_id_2, p_commission_split_pct
  ) RETURNING id INTO v_appointment_id;

  RETURN v_appointment_id;
END;
$$;

-- ── 4. Update get_available_slots: p_min_staff for dual-staff filtering ───────
-- When p_min_staff = 2, only surfaces slots where at least two staff are free,
-- so the client picker never shows times that can't be fully staffed.

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
           gs::time AS s_time
      FROM staff_hours sh,
           generate_series(
             sh.wh_start,
             sh.wh_end - (v_duration || ' minutes')::interval,
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
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
