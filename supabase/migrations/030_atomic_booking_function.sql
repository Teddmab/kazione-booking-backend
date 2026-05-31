-- ---------------------------------------------------------------------------
-- 030_atomic_booking_function.sql
--
-- Wraps the slot check + appointment INSERT in a single PostgreSQL transaction
-- protected by pg_advisory_xact_lock. Two concurrent requests for the same
-- (business, staff, slot) will queue behind the lock. The second one will find
-- the slot occupied and receive SLOT_TAKEN instead of creating a duplicate row.
--
-- appointment_services and payments are inserted by the edge function after
-- this call — they are not time-sensitive and do not need to be inside the lock.
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
  -- Acquire a transaction-scoped advisory lock keyed on
  -- (business_id, staff_id, slot start-time). Any concurrent transaction
  -- trying to book the same slot will block here until we commit or rollback.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_business_id::text || p_staff_id::text || p_starts_at::text)
  );

  -- Re-check slot availability INSIDE the lock.
  -- A slot is blocked when:
  --   • The appointment is confirmed.
  --   • Payment is paid/succeeded.
  --   • A pending card payment exists and was created within the last 30 min.
  SELECT COUNT(*) = 0 INTO v_slot_available
  FROM appointments a
  LEFT JOIN payments pay ON pay.appointment_id = a.id
  WHERE a.business_id = p_business_id
    AND a.staff_profile_id = p_staff_id
    AND a.status NOT IN ('cancelled', 'no_show')
    AND (a.starts_at, a.ends_at) OVERLAPS (p_starts_at, p_ends_at)
    AND (
      a.status = 'confirmed'
      OR pay.status::text IN ('paid', 'succeeded')
      OR (
        pay.method::text != 'cash'
        AND pay.status::text = 'pending'
        AND a.created_at > now() - interval '30 minutes'
      )
    );

  IF NOT v_slot_available THEN
    RAISE EXCEPTION 'SLOT_TAKEN: The selected time slot is no longer available';
  END IF;

  -- Atomically insert the appointment while holding the lock.
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
