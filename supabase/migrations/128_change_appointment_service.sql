-- 128_change_appointment_service.sql
--
-- Owners/managers had no way to correct the service on a confirmed,
-- not-yet-completed appointment (e.g. the wrong service was booked, or the
-- client's needs changed) short of cancelling and rebooking. Adds
-- change_appointment_service_atomic, following the exact same shape as
-- reschedule_appointment_atomic/assign_staff_atomic (112_check_and_reserve_slot.sql):
-- lock the row, recompute the new end time from the new service's own
-- duration (starts_at is left untouched — this swaps the service, it does
-- not reschedule the appointment), re-check the assigned staff's schedule
-- against that new end time using the NEW service's own buffer, then write.
--
-- price is updated to the new service's price: unlike final_price (the
-- completion-time audited override added in 127_appointment_completion_step1.sql,
-- which deliberately never touches price so the original booking value is
-- preserved), this runs on an appointment that hasn't been completed yet —
-- it's a correction to what was actually booked, so the booking's own price
-- record should reflect it, exactly as it would if the client had booked
-- the correct service to begin with.

CREATE OR REPLACE FUNCTION change_appointment_service_atomic(
  p_appointment_id        uuid,
  p_new_service_id        uuid,
  p_new_duration_minutes  int,
  p_new_buffer_minutes    int,
  p_new_price             numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_business_id  uuid;
  v_staff_id     uuid;
  v_starts_at    timestamptz;
  v_new_ends_at  timestamptz;
BEGIN
  SELECT a.business_id, a.staff_profile_id, a.starts_at
    INTO v_business_id, v_staff_id, v_starts_at
    FROM appointments a
   WHERE a.id = p_appointment_id
   FOR UPDATE OF a;

  IF v_business_id IS NULL THEN
    RAISE EXCEPTION 'APPOINTMENT_NOT_FOUND: Appointment does not exist';
  END IF;

  v_new_ends_at := v_starts_at + (p_new_duration_minutes || ' minutes')::interval;

  PERFORM check_and_reserve_slot(
    v_business_id, v_staff_id, v_starts_at, v_new_ends_at, p_new_buffer_minutes, p_appointment_id
  );

  UPDATE appointments
     SET service_id        = p_new_service_id,
         duration_minutes  = p_new_duration_minutes,
         ends_at           = v_new_ends_at,
         price             = p_new_price
   WHERE id = p_appointment_id;
END;
$$;
