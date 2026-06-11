-- 049_staff_schedule_overrides.sql
--
-- Two changes:
--
-- 1. Fix availability gap: "pay later" appointments were released after 30 min
--    Both get_available_slots and create_booking_atomic treated pending
--    non-cash appointments as "abandoned checkout" after 30 minutes and stopped
--    blocking the slot. For payment_method = 'later' (pay at salon) this is
--    wrong — those are real bookings and must permanently hold the slot.
--    Fix: add a 'later' method condition so those appointments are always blocked.
--
-- 2. Staff schedule overrides: new table + updated get_available_slots so owners
--    can set custom working hours for a specific date (overrides the weekly
--    schedule). Useful for setting "this month we work 8–14" or blocking a
--    team on a specific public holiday without touching the weekly template.

-- ── 1. staff_schedule_overrides table ─────────────────────────────────────────

CREATE TABLE staff_schedule_overrides (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_profile_id uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  business_id      uuid NOT NULL REFERENCES businesses(id)      ON DELETE CASCADE,
  override_date    date NOT NULL,
  is_working       boolean NOT NULL DEFAULT true,
  start_time       time,                    -- NULL when is_working = false
  end_time         time,                    -- NULL when is_working = false
  reason           text,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chk_override_hours
    CHECK (
      NOT is_working
      OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time)
    ),
  UNIQUE (staff_profile_id, override_date)
);

CREATE INDEX idx_schedule_overrides_staff_date
  ON staff_schedule_overrides (staff_profile_id, override_date);

COMMENT ON TABLE staff_schedule_overrides IS
  'Date-specific working-hour overrides. One row per staff member per date. '
  'Takes precedence over staff_working_hours for that date.';

-- Edge functions use supabase admin (service role) which bypasses RLS.
-- Enable RLS so direct DB access is still gated.
ALTER TABLE staff_schedule_overrides ENABLE ROW LEVEL SECURITY;


-- ── 2. Fix get_available_slots: block 'later' payment appointments always ──────

DROP FUNCTION IF EXISTS get_available_slots(uuid, uuid, uuid, date);

CREATE OR REPLACE FUNCTION get_available_slots(
    p_business_id uuid,
    p_service_id  uuid,
    p_staff_id    uuid DEFAULT NULL,
    p_date        date DEFAULT CURRENT_DATE
  ) RETURNS TABLE (
    slot_time        time,
    staff_profile_id uuid,
    staff_name       text,
    custom_price     numeric
  )
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_duration      int;
  v_buffer        int;
  v_slot_interval int;
  v_lead_hours    int;
  v_future_days   int;
  v_earliest_time timestamptz;
  v_max_date      date;
BEGIN
  SELECT s.duration_minutes, COALESCE(s.buffer_minutes, 0)
    INTO v_duration, v_buffer
    FROM services s
   WHERE s.id = p_service_id
     AND s.business_id = p_business_id
     AND s.is_active = true;

  IF v_duration IS NULL THEN RETURN; END IF;

  SELECT COALESCE(bs.slot_duration_minutes, 30),
         COALESCE(bs.booking_lead_time_hours, 2),
         COALESCE(bs.booking_future_days, 60)
    INTO v_slot_interval, v_lead_hours, v_future_days
    FROM business_settings bs
   WHERE bs.business_id = p_business_id;

  v_slot_interval := COALESCE(v_slot_interval, 30);
  v_lead_hours    := COALESCE(v_lead_hours, 2);
  v_future_days   := COALESCE(v_future_days, 60);

  v_max_date      := CURRENT_DATE + v_future_days;
  IF p_date > v_max_date THEN RETURN; END IF;

  v_earliest_time := now() + (v_lead_hours || ' hours')::interval;

  RETURN QUERY
  WITH eligible_staff AS (
    SELECT sp.id AS sp_id,
           sp.display_name,
           COALESCE(ss.custom_price, srv.price) AS eff_price,
           bm.user_id AS member_user_id
      FROM staff_services   ss
      JOIN staff_profiles   sp  ON sp.id  = ss.staff_profile_id
      JOIN services         srv ON srv.id = ss.service_id
      LEFT JOIN business_members bm ON bm.id = sp.business_member_id
     WHERE ss.service_id  = p_service_id
       AND sp.business_id = p_business_id
       AND sp.is_active   = true
       AND (p_staff_id IS NULL OR sp.id = p_staff_id)
  ),
  -- Date-specific override (wins over weekly schedule when present)
  date_override AS (
    SELECT sso.staff_profile_id AS sp_id,
           sso.is_working,
           sso.start_time,
           sso.end_time
      FROM staff_schedule_overrides sso
     WHERE sso.business_id    = p_business_id
       AND sso.override_date  = p_date
       AND sso.staff_profile_id IN (SELECT sp_id FROM eligible_staff)
  ),
  staff_hours AS (
    -- For each eligible staff member:
    --   • if an override exists for p_date and is_working = true  → use override times
    --   • if an override exists for p_date and is_working = false → skip (excluded by WHERE)
    --   • if no override → fall back to weekly staff_working_hours
    SELECT es.sp_id,
           es.display_name,
           es.eff_price,
           es.member_user_id,
           COALESCE(ov.start_time, wh.start_time) AS wh_start,
           COALESCE(ov.end_time,   wh.end_time)   AS wh_end
      FROM eligible_staff es
      LEFT JOIN date_override ov
        ON ov.sp_id = es.sp_id
      LEFT JOIN staff_working_hours wh
        ON wh.staff_profile_id = es.sp_id
       AND wh.day_of_week      = EXTRACT(DOW FROM p_date)::int
       AND wh.is_working       = true
     WHERE (ov.sp_id IS NOT NULL AND ov.is_working = true)   -- override: working
        OR (ov.sp_id IS NULL     AND wh.staff_profile_id IS NOT NULL) -- no override, weekly says working
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
             (p_date::text || ' ' || sh.wh_end::text   || ' +00')::timestamptz
               - ((v_duration + v_buffer) || ' minutes')::interval,
             (v_slot_interval || ' minutes')::interval
           ) gs
  ),
  blocked AS (
    -- Appointments that occupy a slot.  We block:
    --   a) status = 'confirmed'                    — definitively booked
    --   b) payment paid / succeeded                — money received
    --   c) payment_method = 'later' (pay at salon) — real booking, never stale
    --   d) other pending payment < 30 min old      — online checkout in progress
    --   e) any appointment < 30 sec old            — race-condition guard
    SELECT DISTINCT
           es.sp_id,
           a.starts_at,
           a.ends_at
             + (COALESCE(booked_srv.buffer_minutes, 0) || ' minutes')::interval
             AS effective_ends_at
      FROM eligible_staff es
      JOIN appointments a
        ON a.starts_at::date = p_date
      LEFT JOIN services       booked_srv ON booked_srv.id  = a.service_id
      LEFT JOIN staff_profiles booked_sp  ON booked_sp.id   = a.staff_profile_id
      LEFT JOIN business_members booked_bm ON booked_bm.id  = booked_sp.business_member_id
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
         -- a. Confirmed
         a.status = 'confirmed'
         -- b. Paid online
         OR p.status::text IN ('paid', 'succeeded')
         -- c. Pay-at-salon — always a real booking, never treat as abandoned
         OR p.method::text = 'later'
         -- d. Online checkout in progress (< 30 min)
         OR (
           p.status::text  = 'pending'
           AND a.created_at > now() - interval '30 minutes'
         )
         -- e. Race-condition guard: just created (< 30 sec)
         OR a.created_at > now() - interval '30 seconds'
       )
  ),
  time_off AS (
    SELECT sto.staff_profile_id AS sp_id,
           sto.starts_at,
           sto.ends_at
      FROM staff_time_off sto
     WHERE sto.business_id  = p_business_id
       AND sto.starts_at    < (p_date + 1)::timestamptz
       AND sto.ends_at      > p_date::timestamptz
  )
  SELECT DISTINCT
         (ss.slot_start AT TIME ZONE 'UTC')::time AS slot_time,
         ss.sp_id                                  AS staff_profile_id,
         ss.display_name                            AS staff_name,
         ss.eff_price                               AS custom_price
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
$$;


-- ── 3. Fix create_booking_atomic: block 'later' payment appointments always ────

CREATE OR REPLACE FUNCTION create_booking_atomic(
  p_business_id       uuid,
  p_service_id        uuid,
  p_staff_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_buffer_minutes    int,
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

  SELECT COUNT(*) = 0 INTO v_slot_available
    FROM appointments a
    LEFT JOIN services booked_srv ON booked_srv.id = a.service_id
   WHERE a.business_id      = p_business_id
     AND a.staff_profile_id = p_staff_id
     AND a.status NOT IN ('cancelled', 'no_show')
     AND a.starts_at < (p_ends_at   + (p_buffer_minutes || ' minutes')::interval)
     AND (a.ends_at  + (COALESCE(booked_srv.buffer_minutes, 0) || ' minutes')::interval) > p_starts_at
     AND (
       -- a. Confirmed
       a.status = 'confirmed'

       -- b. Paid online
       OR EXISTS (
         SELECT 1 FROM payments p2
          WHERE p2.appointment_id = a.id
            AND p2.status::text IN ('paid', 'succeeded')
       )

       -- c. Pay-at-salon — always a real booking
       OR EXISTS (
         SELECT 1 FROM payments p2
          WHERE p2.appointment_id = a.id
            AND p2.method::text = 'later'
       )

       -- d. Online checkout in progress (< 30 min)
       OR EXISTS (
         SELECT 1 FROM payments p2
          WHERE p2.appointment_id = a.id
            AND p2.status::text  = 'pending'
            AND a.created_at     > now() - interval '30 minutes'
       )

       -- e. Race-condition guard
       OR a.created_at > now() - interval '30 seconds'
     );

  IF NOT v_slot_available THEN
    RAISE EXCEPTION 'SLOT_TAKEN: The selected time slot is no longer available';
  END IF;

  INSERT INTO appointments (
    business_id, service_id, staff_profile_id,
    starts_at, ends_at, duration_minutes,
    client_id, status, booking_reference,
    price, deposit_amount, booking_source, is_walk_in, notes
  ) VALUES (
    p_business_id, p_service_id, p_staff_id,
    p_starts_at, p_ends_at,
    EXTRACT(EPOCH FROM (p_ends_at - p_starts_at))::int / 60,
    p_client_id, 'pending', p_booking_reference,
    p_price, p_deposit_amount,
    p_booking_source::booking_source, p_is_walk_in, p_notes
  ) RETURNING id INTO v_appointment_id;

  RETURN v_appointment_id;
END;
$$;
