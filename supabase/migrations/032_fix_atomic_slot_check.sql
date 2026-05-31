-- ---------------------------------------------------------------------------
-- 032_fix_atomic_slot_check.sql
--
-- The original create_booking_atomic function mirrored the get_available_slots
-- availability logic: a pending appointment paid with cash (pay-later) does
-- NOT block the slot. This is intentional in the availability view — ghost
-- cash bookings should not hold slots indefinitely.
--
-- However, inside the advisory-lock context the goal is different: we need
-- to prevent two concurrent booking attempts from BOTH succeeding for the
-- same slot. Any non-cancelled overlapping appointment that exists at the
-- time of the check has already claimed the slot, regardless of payment
-- status or method.
--
-- This migration replaces the function with a simpler, correct check:
--   ANY non-cancelled overlapping appointment → slot is taken.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION create_booking_atomic(
  p_business_id       uuid,
  p_service_id        uuid,
  p_staff_id          uuid,
  p_starts_at         timestamptz,
  p_ends_at           timestamptz,
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
  -- Acquire transaction-scoped advisory lock to serialise concurrent booking
  -- attempts for the same (business, staff, slot).
  PERFORM pg_advisory_xact_lock(
    hashtext(p_business_id::text || p_staff_id::text || p_starts_at::text)
  );

  -- Inside the lock: any non-cancelled overlapping appointment blocks the slot.
  -- This is intentionally stricter than get_available_slots (which exempts
  -- cash/pending bookings) — the goal here is to prevent double-INSERT, not
  -- to compute customer-visible availability.
  SELECT COUNT(*) = 0 INTO v_slot_available
  FROM appointments a
  WHERE a.business_id   = p_business_id
    AND a.staff_profile_id = p_staff_id
    AND a.status NOT IN ('cancelled', 'no_show')
    AND (a.starts_at, a.ends_at) OVERLAPS (p_starts_at, p_ends_at);

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
