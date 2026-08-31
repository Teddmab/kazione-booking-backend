-- ─────────────────────────────────────────────────────────────────────────────
-- 136_seat_capacity_shadow.sql
--
-- SPRINT: Salon Seat Capacity — Stage 1 (configuration + shadow evaluation).
-- See team/FRONTEND/OWNER/KAZIONE_SPRINT_OWNER_PORTAL_SEAT_CAPACITY.md for the
-- full product spec and the approved decision gates this migration implements.
--
-- Numbered 136 (not 131) because origin/main had already merged an unrelated
-- 131_platform_storefront_launch_config.sql (and 132–135) by the time this
-- PR was opened — this work was developed on a feature branch that had
-- fallen behind main, so the number was never actually claimed by this
-- migration outside that stale local branch. Built directly on origin/main
-- to avoid any collision; content is otherwise unchanged from development.
--
-- Correction from an earlier draft of this migration: capacity is a *count*
-- of overlapping appointments against a business-level maximum, not a sum of
-- a per-service "seat unit" flag. A service can never require more than one
-- unit of salon capacity, and seat consumption is not a service-level
-- concept — so there is no services.consumes_salon_capacity, no
-- appointments.seat_units_snapshot, and no per-service review gate
-- (business_settings.capacity_services_reviewed_at). A two-staff service
-- still occupies exactly one unit of salon capacity, because it is still
-- one appointment.
--
-- KaziOne today derives bookable capacity purely from staff schedules
-- (staff_working_hours/staff_time_off/appointments, see 004/113). It has no
-- independent limit on how many appointments a salon can physically host at
-- once. This migration adds the *shadow* half of that: business-level
-- configuration and a logging-only discrepancy check inside
-- check_and_reserve_slot (112) — the single choke point already shared by
-- every booking write path (create_booking_atomic,
-- create_manual_appointment_atomic, assign_staff_atomic, assign_staff_2_atomic,
-- reschedule_appointment_atomic, change_appointment_service_atomic). Nothing
-- in this migration rejects a booking — that's a future, pilot-only stage.
--
-- Every one of the six atomic RPCs keeps its exact pre-existing signature
-- except check_and_reserve_slot, which gains exactly one new parameter
-- (p_source text DEFAULT NULL, for shadow-log attribution — not a
-- capacity-relevant value, so it carries no overload risk of its own).
-- Signature changes across CREATE OR REPLACE FUNCTION calls change a
-- function's identity in pg_proc (name + argument types), so any real
-- signature change would silently create a second overload rather than
-- replacing the original. Restoring the original signatures here — rather
-- than an earlier draft's approach of appending capacity-related parameters
-- to four of the six RPCs — avoids that risk entirely.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. business_settings: capacity configuration ────────────────────────────
-- Business-level only: the maximum number of appointments the salon can
-- physically host at the same time, independent of staff availability.
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS seat_capacity_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS seat_count             int
    CONSTRAINT chk_seat_count_positive CHECK (seat_count IS NULL OR seat_count > 0);

COMMENT ON COLUMN business_settings.seat_capacity_enabled IS
  'Stage 1 (shadow): when true, check_and_reserve_slot logs would-have-conflicted bookings to appointment_capacity_shadow_log but never rejects. No enforcement exists yet.';
COMMENT ON COLUMN business_settings.seat_count IS
  'Maximum number of appointments this business can host at the same time, regardless of how many staff are free. Business-level only — not a sum of any per-service or per-appointment value.';

-- ── 2. appointment_capacity_shadow_log: informational discrepancy log ───────
-- Same "one small table per actor-domain audit trail" pattern as
-- appointment_price_log (127) / admin_audit_log / staff_action_log.
-- Insert-only, written exclusively from inside check_and_reserve_slot via
-- SECURITY DEFINER — never blocks a booking, only records that a booking
-- attempt would have exceeded the configured seat_count had enforcement
-- been active. One row per attempt that would have exceeded capacity, not
-- one row per attempt overall.
CREATE TABLE IF NOT EXISTS appointment_capacity_shadow_log (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- NULL for a brand-new booking (checked before the appointment row exists);
  -- set for reassignment/reschedule/change-service, which check an existing row.
  appointment_id       uuid        REFERENCES appointments(id) ON DELETE CASCADE,
  starts_at            timestamptz NOT NULL,
  ends_at              timestamptz NOT NULL,
  configured_capacity  int         NOT NULL,
  overlapping_count    int         NOT NULL,
  would_exceed         boolean     NOT NULL,
  -- Which RPC triggered this check (create_booking_atomic,
  -- create_manual_appointment_atomic, assign_staff_atomic,
  -- assign_staff_2_atomic, reschedule_appointment_atomic,
  -- change_appointment_service_atomic) — free text, not an enum, so a future
  -- caller never needs a migration just to be attributable.
  source               text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_capacity_shadow_log_business_time
  ON appointment_capacity_shadow_log (business_id, created_at DESC);

ALTER TABLE appointment_capacity_shadow_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "business_read_appointment_capacity_shadow_log"
  ON appointment_capacity_shadow_log FOR SELECT
  USING (
    business_id IN (SELECT get_my_business_ids())
    AND get_user_role(business_id) IN ('owner', 'manager')
  );

-- Inserts come exclusively from check_and_reserve_slot (SECURITY DEFINER,
-- bypasses RLS). No user-facing INSERT/UPDATE/DELETE policies — append-only.

COMMENT ON TABLE appointment_capacity_shadow_log IS
  'Stage 1 shadow-mode log: rows written when a booking write path would have exceeded the configured seat_count, had seat capacity enforcement existed. Informational only — nothing in Stage 1 rejects a booking based on this.';

-- ── 3. check_and_reserve_slot: add the shadow-mode seat check ───────────────
-- Only new parameter is p_source (attribution, not capacity-relevant) —
-- every other parameter and all existing staff-conflict behavior below is
-- byte-for-byte unchanged from 112_check_and_reserve_slot.sql.
--
-- Concurrency: two different-staff bookings can otherwise observe the same
-- "capacity free" count and both commit, because the existing advisory lock
-- key is scoped to (business_id, staff_id, starts_at) — it does not
-- serialize across different staff members. A second, business-scoped
-- advisory lock is taken here so that a future enforcement stage cannot
-- oversell the last unit of capacity. Taking the lock now (even though this
-- migration never rejects) means enforcement requires no further
-- concurrency changes to this function.
CREATE OR REPLACE FUNCTION check_and_reserve_slot(
  p_business_id             uuid,
  p_staff_id                uuid,
  p_starts_at               timestamptz,
  p_ends_at                 timestamptz,
  p_buffer_minutes          int,
  p_exclude_appointment_id  uuid DEFAULT NULL,
  p_source                  text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slot_available        boolean;
  v_seat_capacity_enabled boolean;
  v_seat_count            int;
  v_overlapping_count     int;
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

  -- ── Salon capacity — shadow mode only, never raises ───────────────────────
  -- Every capacity-blocking appointment counts as exactly one unit —
  -- COUNT(*), never a sum of any per-service or per-appointment value.
  SELECT bs.seat_capacity_enabled, bs.seat_count
    INTO v_seat_capacity_enabled, v_seat_count
    FROM business_settings bs
   WHERE bs.business_id = p_business_id;

  IF v_seat_capacity_enabled IS TRUE AND v_seat_count IS NOT NULL THEN
    -- Business-scoped lock, separate from the per-staff lock above, so
    -- concurrent checks for *different* staff serialize against each other
    -- for the purposes of this count.
    PERFORM pg_advisory_xact_lock(hashtext(p_business_id::text || ':seat_capacity'));

    -- Deliberately broader than the staff predicate above: this answers "how
    -- many appointments physically occupy this interval", not "does this
    -- specific staff member have a conflict" — so pending/offered/
    -- in_progress/pending_completion all count regardless of payment state.
    -- Completed appointments don't count against future capacity.
    SELECT COUNT(*) INTO v_overlapping_count
      FROM appointments a
     WHERE a.business_id = p_business_id
       AND (p_exclude_appointment_id IS NULL OR a.id != p_exclude_appointment_id)
       AND a.status NOT IN ('cancelled', 'no_show', 'completed')
       AND a.starts_at < p_ends_at
       AND a.ends_at   > p_starts_at;

    -- The appointment being checked is one additional unit.
    IF v_overlapping_count + 1 > v_seat_count THEN
      INSERT INTO appointment_capacity_shadow_log (
        business_id, appointment_id, starts_at, ends_at,
        configured_capacity, overlapping_count, would_exceed, source
      ) VALUES (
        p_business_id, p_exclude_appointment_id, p_starts_at, p_ends_at,
        v_seat_count, v_overlapping_count, true, p_source
      );
    END IF;
  END IF;
END;
$$;

-- ── 4. create_booking_atomic: exact pre-existing signature, unchanged body
--      except passing p_source through ────────────────────────────────────
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
    p_business_id, p_staff_id, p_starts_at, p_ends_at, p_buffer_minutes, NULL, 'create_booking_atomic'
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

-- ── 5. create_manual_appointment_atomic: same ────────────────────────────────
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
    p_business_id, p_staff_id, p_starts_at, p_ends_at, p_buffer_minutes, NULL, 'create_manual_appointment_atomic'
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

-- ── 6. assign_staff_atomic: same exact pre-existing signature ───────────────
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
    v_business_id, p_staff_id, v_starts_at, v_ends_at, v_buffer_minutes, p_appointment_id, 'assign_staff_atomic'
  );

  UPDATE appointments
     SET staff_profile_id = p_staff_id,
         status = p_new_status::appointment_status
   WHERE id = p_appointment_id;
END;
$$;

-- ── 7. assign_staff_2_atomic: same exact pre-existing signature ─────────────
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
    -- Assigning a second staff member never adds a second unit of salon
    -- capacity: a two-staff service is still one appointment, one interval,
    -- one unit. This call checks the same appointment's own interval again
    -- (for the second staff member's conflict check) — since the capacity
    -- count excludes this appointment via p_exclude_appointment_id and then
    -- adds exactly +1 back for "the appointment being checked", calling
    -- this twice for the same appointment never double-counts it.
    PERFORM check_and_reserve_slot(
      v_business_id, p_staff_id_2, v_starts_at, v_ends_at, v_buffer_minutes, p_appointment_id, 'assign_staff_2_atomic'
    );
  END IF;

  UPDATE appointments
     SET staff_profile_id_2 = p_staff_id_2,
         commission_split_pct = p_commission_split_pct
   WHERE id = p_appointment_id;
END;
$$;

-- ── 8. reschedule_appointment_atomic: same exact pre-existing signature ─────
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
    v_business_id, p_new_staff_id, p_new_starts_at, p_new_ends_at, v_buffer_minutes, p_appointment_id, 'reschedule_appointment_atomic'
  );

  UPDATE appointments
     SET starts_at = p_new_starts_at,
         ends_at = p_new_ends_at,
         staff_profile_id = p_new_staff_id,
         status = 'confirmed'
   WHERE id = p_appointment_id;
END;
$$;

-- ── 9. change_appointment_service_atomic: same exact pre-existing signature ─
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
    v_business_id, v_staff_id, v_starts_at, v_new_ends_at, p_new_buffer_minutes, p_appointment_id, 'change_appointment_service_atomic'
  );

  UPDATE appointments
     SET service_id        = p_new_service_id,
         duration_minutes  = p_new_duration_minutes,
         ends_at           = v_new_ends_at,
         price             = p_new_price
   WHERE id = p_appointment_id;
END;
$$;
