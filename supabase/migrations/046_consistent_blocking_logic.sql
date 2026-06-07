-- 046_consistent_blocking_logic.sql
--
-- Fixes an inconsistency between get_available_slots and
-- create_booking_atomic:
--
--   get_available_slots (correct): a pending appointment with no paid
--   payment (or with a stale non-cash pending payment > 30 min old) is
--   treated as "abandoned" and does NOT block new bookings.
--
--   create_booking_atomic (bug): blocked on ALL non-cancelled appointments,
--   including those same abandoned pending appointments.
--
-- Consequence: get_available_slots would show a slot as free, the client
-- would call create-booking, and create_booking_atomic would immediately
-- reject with SLOT_TAKEN — a confusing false conflict.
--
-- This also manifested in CI: the seed creates pending appointments with
-- no payment records on relative dates (today+3, today+4). When the
-- pipeline ran close to midnight UTC those dates collided with the test
-- dates in create-booking.test.ts, causing three SLOT_TAKEN failures.
--
-- Fix: apply the same four-condition blocking gate in create_booking_atomic
-- that get_available_slots already uses:
--
--   1. confirmed appointments    — always block
--   2. paid/succeeded payments   — always block
--   3. non-cash pending payment + appointment created < 30 min ago
--                                — checkout still in progress, block
--   4. appointment created < 30 sec ago (any state)
--                                — race-condition guard for the window
--                                  between create_booking_atomic commit
--                                  and the outer function confirming the
--                                  appointment (typically < 100 ms).
--                                  30 s >> 100 ms but safely excludes seed
--                                  appointments created > 60 s before tests.
--
-- Anything older that doesn't meet conditions 1–3 is treated as abandoned
-- and no longer blocks new bookings, matching get_available_slots exactly.

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
     AND a.starts_at < (p_ends_at + (p_buffer_minutes || ' minutes')::interval)
     AND (a.ends_at + (COALESCE(booked_srv.buffer_minutes, 0) || ' minutes')::interval) > p_starts_at
     AND (
       -- 1. Confirmed appointment — definitively booked
       a.status = 'confirmed'

       -- 2. Payment already settled
       OR EXISTS (
         SELECT 1 FROM payments p2
          WHERE p2.appointment_id = a.id
            AND p2.status::text IN ('paid', 'succeeded')
       )

       -- 3. Online checkout in progress (non-cash pending, created < 30 min)
       OR EXISTS (
         SELECT 1 FROM payments p2
          WHERE p2.appointment_id = a.id
            AND p2.method::text <> 'cash'
            AND p2.status::text = 'pending'
            AND a.created_at > now() - interval '30 minutes'
       )

       -- 4. Race-condition guard: any appointment created in the last 30 sec —
       --    covers the gap between create_booking_atomic committing and the
       --    outer edge function inserting the payment + confirming (< 1 sec).
       --    30 seconds is generous for that window while safely excluding
       --    seed / fixture appointments created > 60 s before tests run.
       OR a.created_at > now() - interval '30 seconds'
     );

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
