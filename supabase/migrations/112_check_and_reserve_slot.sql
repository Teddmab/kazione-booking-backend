-- ---------------------------------------------------------------------------
-- 112_check_and_reserve_slot.sql  —  S58: Booking Conflict-Lock Hardening
-- ---------------------------------------------------------------------------
-- create_booking_atomic (086_dual_staff.sql) is the only write path that
-- takes the advisory lock + buffer-aware overlap check before writing —
-- manual/staff-created bookings, staff (re)assignment, and reschedule all
-- bypass it, so a staff member can be silently double-booked through the
-- owner dashboard even though the public booking flow is race-safe.
--
-- This migration extracts the shared conflict predicate into
-- check_and_reserve_slot(), refactors create_booking_atomic to call it (no
-- behavior change), and adds three purpose-built atomic wrapper functions —
-- one per newly-hardened write path — each doing lock+check+write inside a
-- single function call, since PostgREST/Supabase-js treats every separate
-- RPC or table call as its own transaction: a standalone conflict-check RPC
-- followed by a separate .update() call would NOT be race-safe, because the
-- advisory lock releases as soon as the check call's transaction ends.
-- ---------------------------------------------------------------------------

-- ── 1. Shared conflict predicate (check-only, raises SLOT_TAKEN) ────────────
-- Same predicate create_booking_atomic already used — excludes cancelled/
-- no_show, blocks against confirmed / paid / later-method / recent-pending
-- appointments, buffer-aware on both sides. p_exclude_appointment_id lets a
-- reassignment/reschedule exclude the row being moved from its own check.
-- Must always be called from inside a plpgsql function that performs the
-- actual write immediately after, in the same transaction.
CREATE OR REPLACE FUNCTION check_and_reserve_slot(
  p_business_id             uuid,
  p_staff_id                uuid,
  p_starts_at               timestamptz,
  p_ends_at                 timestamptz,
  p_buffer_minutes          int,
  p_exclude_appointment_id  uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
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
     AND (p_exclude_appointment_id IS NULL OR a.id != p_exclude_appointment_id)
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
END;
$$;

-- ── 2. Refactor create_booking_atomic to use the shared predicate ──────────
-- Signature and behavior unchanged — existing callers (create-booking) see
-- no difference. Note: when p_staff_id is NULL (staff-less bookings),
-- pg_advisory_xact_lock(NULL) and the staff_profile_id = NULL comparison
-- both no-op per Postgres NULL semantics, exactly as before this refactor —
-- check_and_reserve_slot preserves that behavior unchanged.
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
BEGIN
  PERFORM check_and_reserve_slot(
    p_business_id, p_staff_id, p_starts_at, p_ends_at, p_buffer_minutes, NULL
  );

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

-- ── 3. Manual/staff-created booking (appointments POST) ────────────────────
-- Mirrors create_booking_atomic's shape but for the owner-dashboard manual
-- booking flow, which has its own status logic (confirmed if staff already
-- assigned, else pending) and an internal_notes field create-booking never
-- uses.
CREATE OR REPLACE FUNCTION create_manual_appointment_atomic(
  p_business_id       uuid,
  p_client_id         uuid,
  p_service_id        uuid,
  p_staff_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
  p_duration_minutes  int,
  p_buffer_minutes    int,
  p_price             numeric,
  p_deposit_amount    numeric,
  p_booking_source    text,
  p_booking_reference text,
  p_is_walk_in        boolean,
  p_notes             text,
  p_internal_notes    text,
  p_status            text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_appointment_id uuid;
BEGIN
  PERFORM check_and_reserve_slot(
    p_business_id, p_staff_id, p_starts_at, p_ends_at, p_buffer_minutes, NULL
  );

  INSERT INTO appointments (
    business_id, client_id, service_id, staff_profile_id,
    starts_at, ends_at, duration_minutes,
    price, deposit_amount, booking_source, booking_reference,
    is_walk_in, notes, internal_notes, status
  ) VALUES (
    p_business_id, p_client_id, p_service_id, p_staff_id,
    p_starts_at, p_ends_at, p_duration_minutes,
    p_price, p_deposit_amount, p_booking_source::booking_source, p_booking_reference,
    p_is_walk_in, p_notes, p_internal_notes, p_status::appointment_status
  ) RETURNING id INTO v_appointment_id;

  RETURN v_appointment_id;
END;
$$;

-- ── 4. Staff (re)assignment — primary staff ─────────────────────────────────
-- Looks up the appointment's own timing/service buffer server-side (the
-- caller only has an id), locks the row against concurrent assignment, then
-- checks the target staff member's schedule excluding this appointment's
-- own current slot.
CREATE OR REPLACE FUNCTION assign_staff_atomic(
  p_appointment_id  uuid,
  p_staff_id        uuid,
  p_new_status      text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id     uuid;
  v_starts_at       timestamptz;
  v_ends_at         timestamptz;
  v_buffer_minutes  int;
BEGIN
  SELECT a.business_id, a.starts_at, a.ends_at, COALESCE(s.buffer_minutes, 0)
    INTO v_business_id, v_starts_at, v_ends_at, v_buffer_minutes
    FROM appointments a
    LEFT JOIN services s ON s.id = a.service_id
   WHERE a.id = p_appointment_id
   FOR UPDATE OF a;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'APPOINTMENT_NOT_FOUND: Appointment does not exist';
  END IF;

  PERFORM check_and_reserve_slot(
    v_business_id, p_staff_id, v_starts_at, v_ends_at, v_buffer_minutes, p_appointment_id
  );

  UPDATE appointments
     SET staff_profile_id = p_staff_id,
         status = p_new_status::appointment_status
   WHERE id = p_appointment_id;
END;
$$;

-- ── 5. Staff (re)assignment — secondary staff (dual-staff services) ────────
-- Clearing the assignment (p_staff_id_2 = NULL) never needs a conflict
-- check — removing someone from a slot can't create a double-booking.
CREATE OR REPLACE FUNCTION assign_staff_2_atomic(
  p_appointment_id        uuid,
  p_staff_id_2            uuid,
  p_commission_split_pct  numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id     uuid;
  v_starts_at       timestamptz;
  v_ends_at         timestamptz;
  v_buffer_minutes  int;
BEGIN
  SELECT a.business_id, a.starts_at, a.ends_at, COALESCE(s.buffer_minutes, 0)
    INTO v_business_id, v_starts_at, v_ends_at, v_buffer_minutes
    FROM appointments a
    LEFT JOIN services s ON s.id = a.service_id
   WHERE a.id = p_appointment_id
   FOR UPDATE OF a;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'APPOINTMENT_NOT_FOUND: Appointment does not exist';
  END IF;

  IF p_staff_id_2 IS NOT NULL THEN
    PERFORM check_and_reserve_slot(
      v_business_id, p_staff_id_2, v_starts_at, v_ends_at, v_buffer_minutes, p_appointment_id
    );
  END IF;

  UPDATE appointments
     SET staff_profile_id_2 = p_staff_id_2,
         commission_split_pct = p_commission_split_pct
   WHERE id = p_appointment_id;
END;
$$;

-- ── 6. Reschedule — closes the TOCTOU gap between the availability re-check
--      and the final write ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reschedule_appointment_atomic(
  p_appointment_id  uuid,
  p_new_starts_at   timestamptz,
  p_new_ends_at     timestamptz,
  p_new_staff_id    uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id     uuid;
  v_buffer_minutes  int;
BEGIN
  SELECT a.business_id, COALESCE(s.buffer_minutes, 0)
    INTO v_business_id, v_buffer_minutes
    FROM appointments a
    LEFT JOIN services s ON s.id = a.service_id
   WHERE a.id = p_appointment_id
   FOR UPDATE OF a;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'APPOINTMENT_NOT_FOUND: Appointment does not exist';
  END IF;

  PERFORM check_and_reserve_slot(
    v_business_id, p_new_staff_id, p_new_starts_at, p_new_ends_at, v_buffer_minutes, p_appointment_id
  );

  UPDATE appointments
     SET starts_at = p_new_starts_at,
         ends_at = p_new_ends_at,
         staff_profile_id = p_new_staff_id,
         status = 'confirmed'
   WHERE id = p_appointment_id;
END;
$$;
