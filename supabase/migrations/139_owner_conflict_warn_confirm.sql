-- ─────────────────────────────────────────────────────────────────────────────
-- 139_owner_conflict_warn_confirm.sql
--
-- Product decision (discussed and confirmed with the owner): the public
-- booking flow (create_booking_atomic, client self-service reschedule)
-- keeps hard-blocking on both staff-availability and seat-capacity
-- conflicts exactly as today — by the time a public client submits, a
-- rejection is almost always a genuine race (two clients grabbing the last
-- slot/seat), and there's no one on that end to read a warning and decide.
--
-- The OWNER's own tools are different: an owner/manager is a rational actor
-- who sometimes has a real reason to override (a stylist managing two
-- clients' overlapping processing time; a walk-in that legitimately exceeds
-- today's configured seat_count). Blocking them outright from their own
-- scheduling tool is too strict. This migration turns both conflict types
-- into a warn-then-confirm flow for the five owner-facing RPCs:
--   create_manual_appointment_atomic, assign_staff_atomic,
--   assign_staff_2_atomic, reschedule_appointment_atomic,
--   change_appointment_service_atomic
-- create_booking_atomic (public) is untouched — no signature change, no
-- body change — because it never passes the new p_allow_confirm flag, so
-- check_and_reserve_slot's default (false) preserves exactly today's
-- hard-block behavior for it.
--
-- Mechanics: check_and_reserve_slot gains two new trailing parameters,
-- both defaulted so no existing caller needs to change:
--   p_allow_confirm    — true only for the five owner RPCs below. Selects
--                        "this caller supports warn-then-confirm" instead
--                        of "always hard-block" (create_booking_atomic
--                        never sets this, so it always hard-blocks).
--   p_confirm_conflict — the owner's explicit "yes, proceed anyway" from a
--                        resubmitted request, after seeing the warning.
-- When p_allow_confirm is true and a conflict exists:
--   - p_confirm_conflict = false (first attempt): RAISE a distinct
--     *_CONFIRM_REQUIRED exception carrying structured DETAIL (parsed by
--     the edge function into a 409 the frontend renders as a warning
--     dialog) — nothing is written or changed.
--   - p_confirm_conflict = true (owner already confirmed): skip the raise
--     for that specific conflict and proceed. For seat capacity, this is
--     logged with a new outcome, 'overridden', distinguishing "the owner
--     deliberately went over capacity" from Stage 1/2's 'logged_only'
--     (shadow mode, never asked) and 'rejected' (pilot-enforced, blocked).
-- Owner-path seat-capacity warnings are driven by seat_capacity_enabled
-- alone, independent of seat_capacity_enforced and the pilot allowlist —
-- those two continue to govern ONLY the public hard-block path. Any
-- business that has turned capacity tracking on gets the benefit of being
-- warned about its own configured limit in its own tools, pilot or not.
--
-- reschedule_appointment_atomic is the one exception to "hardcode
-- p_allow_confirm=true in the body": it is shared by BOTH the owner
-- dashboard (appointments/index.ts) and the public client self-service
-- reschedule link (reschedule-booking/index.ts). Hardcoding true there
-- would silently give random public clients the warn-then-confirm flow
-- too. Instead it gains p_allow_confirm as a real, defaulted-false
-- parameter: the owner caller now explicitly passes true, the public
-- caller passes nothing and keeps hard-blocking exactly as before. The
-- other four RPCs have no public caller, so they hardcode true safely.
--
-- No change to appointments' storage: nothing prevented two appointments
-- from overlapping the same staff_profile_id at the schema level before
-- this migration, and nothing does now — this only changes whether
-- check_and_reserve_slot raises or proceeds when it finds one.
--
-- Known v1 limitation: the two conflict checks are sequential (staff, then
-- capacity), sharing one p_confirm_conflict flag. If BOTH conflicts exist
-- on the same request, the owner is warned about the staff conflict first;
-- confirming it also silently clears the capacity check on the retry
-- without a second prompt. Nothing unsafe happens (the owner did
-- deliberately confirm an override), but they only ever see the first
-- conflict type encountered. Combining both into a single warning would
-- need to gather both before raising either — left as a follow-up if this
-- proves to matter in practice.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. appointment_capacity_shadow_log: record explicit owner overrides ────
ALTER TABLE appointment_capacity_shadow_log
  DROP CONSTRAINT IF EXISTS chk_capacity_shadow_log_outcome;
ALTER TABLE appointment_capacity_shadow_log
  ADD CONSTRAINT chk_capacity_shadow_log_outcome
    CHECK (outcome IN ('logged_only', 'rejected', 'overridden'));

COMMENT ON COLUMN appointment_capacity_shadow_log.outcome IS
  '''logged_only'' = Stage 1 behaviour, booking still succeeded (business not '
  'pilot-enforced, or the owner path did not need to ask). ''rejected'' = '
  'Stage 2 enforcement actually blocked this booking attempt on the public '
  'path (SEAT_CAPACITY_EXCEEDED). ''overridden'' = an owner/manager saw the '
  'warn-then-confirm prompt on their own tools and explicitly chose to '
  'proceed anyway (139).';

-- ── 2. check_and_reserve_slot: warn-then-confirm for owner-path callers ────
-- CREATE OR REPLACE only replaces a function whose full argument-TYPE list
-- is unchanged — adding parameters (even defaulted ones) makes Postgres
-- create a second, distinct overload instead of replacing the original,
-- which then makes every existing 7-arg call ambiguous between the two.
-- This codebase already has this exact lesson learned repeatedly for
-- get_available_slots (020/027/042/049/089) — drop every prior signature
-- of each function this migration changes before redefining it.
DROP FUNCTION IF EXISTS check_and_reserve_slot(uuid, uuid, timestamptz, timestamptz, int, uuid, text);

CREATE OR REPLACE FUNCTION check_and_reserve_slot(
  p_business_id             uuid,
  p_staff_id                uuid,
  p_starts_at               timestamptz,
  p_ends_at                 timestamptz,
  p_buffer_minutes          int,
  p_exclude_appointment_id  uuid DEFAULT NULL,
  p_source                  text DEFAULT NULL,
  p_allow_confirm           boolean DEFAULT false,
  p_confirm_conflict        boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slot_available        boolean;
  v_seat_capacity_enabled boolean;
  v_seat_capacity_enforced boolean;
  v_seat_count            int;
  v_overlapping_count     int;
  v_is_pilot_business     boolean;
  v_enforce               boolean;
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
    IF p_allow_confirm THEN
      IF NOT p_confirm_conflict THEN
        RAISE EXCEPTION 'STAFF_CONFLICT_CONFIRM_REQUIRED: This staff member already has a conflicting appointment at that time'
          USING DETAIL = json_build_object(
            'conflict_type', 'staff',
            'staff_id', p_staff_id,
            'starts_at', p_starts_at,
            'ends_at', p_ends_at
          )::text;
      END IF;
      -- p_confirm_conflict = true: owner already saw the warning — proceed.
    ELSE
      RAISE EXCEPTION 'SLOT_TAKEN: The selected time slot is no longer available';
    END IF;
  END IF;

  -- ── Salon capacity ─────────────────────────────────────────────────────
  -- Every capacity-blocking appointment counts as exactly one unit —
  -- COUNT(*), never a sum of any per-service or per-appointment value.
  SELECT bs.seat_capacity_enabled, bs.seat_capacity_enforced, bs.seat_count
    INTO v_seat_capacity_enabled, v_seat_capacity_enforced, v_seat_count
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
      IF p_allow_confirm THEN
        -- Owner path: driven by seat_capacity_enabled alone — independent
        -- of seat_capacity_enforced/the pilot allowlist, which continue to
        -- govern ONLY the public hard-block path below.
        IF NOT p_confirm_conflict THEN
          RAISE EXCEPTION 'SEAT_CAPACITY_CONFIRM_REQUIRED: This would exceed this business''s configured seat capacity'
            USING DETAIL = json_build_object(
              'conflict_type', 'seat_capacity',
              'business_id', p_business_id,
              'appointment_id', p_exclude_appointment_id,
              'starts_at', p_starts_at,
              'ends_at', p_ends_at,
              'configured_capacity', v_seat_count,
              'overlapping_count', v_overlapping_count,
              'source', p_source
            )::text;
        ELSE
          INSERT INTO appointment_capacity_shadow_log (
            business_id, appointment_id, starts_at, ends_at,
            configured_capacity, overlapping_count, would_exceed, source, outcome
          ) VALUES (
            p_business_id, p_exclude_appointment_id, p_starts_at, p_ends_at,
            v_seat_count, v_overlapping_count, true, p_source, 'overridden'
          );
        END IF;
      ELSE
        -- Public path: unchanged from 137 — pilot-enforced businesses
        -- actually reject; everyone else just gets a shadow-log row.
        SELECT EXISTS (
          SELECT 1 FROM capacity_enforcement_pilot_businesses peb
           WHERE peb.business_id = p_business_id
        ) INTO v_is_pilot_business;

        v_enforce := v_seat_capacity_enforced IS TRUE AND v_is_pilot_business IS TRUE;

        INSERT INTO appointment_capacity_shadow_log (
          business_id, appointment_id, starts_at, ends_at,
          configured_capacity, overlapping_count, would_exceed, source, outcome
        ) VALUES (
          p_business_id, p_exclude_appointment_id, p_starts_at, p_ends_at,
          v_seat_count, v_overlapping_count, true, p_source,
          CASE WHEN v_enforce THEN 'rejected' ELSE 'logged_only' END
        );

        IF v_enforce THEN
          RAISE EXCEPTION 'SEAT_CAPACITY_EXCEEDED: This time is no longer available';
        END IF;
      END IF;
    END IF;
  END IF;
END;
$$;

-- ── 3. create_manual_appointment_atomic: opt into warn-then-confirm ────────
-- Only new parameter is p_confirm_conflict (trailing, defaulted) — every
-- other parameter and the insert body below are unchanged from 137.
DROP FUNCTION IF EXISTS create_manual_appointment_atomic(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz, int, int, numeric, numeric,
  text, text, boolean, text, text, text
);

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
  p_status            text,
  p_confirm_conflict  boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_appointment_id uuid;
BEGIN
  PERFORM check_and_reserve_slot(
    p_business_id, p_staff_id, p_starts_at, p_ends_at, p_buffer_minutes, NULL,
    'create_manual_appointment_atomic', true, p_confirm_conflict
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

-- ── 4. assign_staff_atomic: opt into warn-then-confirm ──────────────────────
DROP FUNCTION IF EXISTS assign_staff_atomic(uuid, uuid, text);

CREATE OR REPLACE FUNCTION assign_staff_atomic(
  p_appointment_id    uuid,
  p_staff_id          uuid,
  p_new_status        text,
  p_confirm_conflict  boolean DEFAULT false
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
    v_business_id, p_staff_id, v_starts_at, v_ends_at, v_buffer_minutes, p_appointment_id,
    'assign_staff_atomic', true, p_confirm_conflict
  );

  UPDATE appointments
     SET staff_profile_id = p_staff_id,
         status = p_new_status::appointment_status
   WHERE id = p_appointment_id;
END;
$$;

-- ── 5. assign_staff_2_atomic: opt into warn-then-confirm ────────────────────
DROP FUNCTION IF EXISTS assign_staff_2_atomic(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION assign_staff_2_atomic(
  p_appointment_id        uuid,
  p_staff_id_2            uuid,
  p_commission_split_pct  numeric,
  p_confirm_conflict      boolean DEFAULT false
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
      v_business_id, p_staff_id_2, v_starts_at, v_ends_at, v_buffer_minutes, p_appointment_id,
      'assign_staff_2_atomic', true, p_confirm_conflict
    );
  END IF;

  UPDATE appointments
     SET staff_profile_id_2 = p_staff_id_2,
         commission_split_pct = p_commission_split_pct
   WHERE id = p_appointment_id;
END;
$$;

-- ── 6. reschedule_appointment_atomic: opt into warn-then-confirm ───────────
-- Shared with the public reschedule-booking/index.ts caller — see the
-- migration header. p_allow_confirm is a real parameter here (not
-- hardcoded true) so that caller keeps hard-blocking by omitting it.
DROP FUNCTION IF EXISTS reschedule_appointment_atomic(uuid, timestamptz, timestamptz, uuid);

CREATE OR REPLACE FUNCTION reschedule_appointment_atomic(
  p_appointment_id    uuid,
  p_new_starts_at     timestamptz,
  p_new_ends_at       timestamptz,
  p_new_staff_id      uuid,
  p_confirm_conflict  boolean DEFAULT false,
  p_allow_confirm     boolean DEFAULT false
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
    v_business_id, p_new_staff_id, p_new_starts_at, p_new_ends_at, v_buffer_minutes, p_appointment_id,
    'reschedule_appointment_atomic', p_allow_confirm, p_confirm_conflict
  );

  UPDATE appointments
     SET starts_at = p_new_starts_at,
         ends_at = p_new_ends_at,
         staff_profile_id = p_new_staff_id,
         status = 'confirmed'
   WHERE id = p_appointment_id;
END;
$$;

-- ── 7. change_appointment_service_atomic: opt into warn-then-confirm ───────
-- Only caller is appointments/index.ts's PATCH ?action=change-service —
-- owner/manager-only, same as the other four RPCs above, so this gets the
-- same treatment for consistency.
DROP FUNCTION IF EXISTS change_appointment_service_atomic(uuid, uuid, int, int, numeric);

CREATE OR REPLACE FUNCTION change_appointment_service_atomic(
  p_appointment_id        uuid,
  p_new_service_id        uuid,
  p_new_duration_minutes  int,
  p_new_buffer_minutes    int,
  p_new_price             numeric,
  p_confirm_conflict      boolean DEFAULT false
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
    v_business_id, v_staff_id, v_starts_at, v_new_ends_at, p_new_buffer_minutes, p_appointment_id,
    'change_appointment_service_atomic', true, p_confirm_conflict
  );

  UPDATE appointments
     SET service_id        = p_new_service_id,
         duration_minutes  = p_new_duration_minutes,
         ends_at           = v_new_ends_at,
         price             = p_new_price
   WHERE id = p_appointment_id;
END;
$$;
