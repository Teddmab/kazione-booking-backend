-- ─────────────────────────────────────────────────────────────────────────────
-- 140_remove_cross_business_double_booking_guard.sql
--
-- Two changes to prevent_staff_double_bookings() (027), the trigger that
-- unconditionally vetoes any overlapping appointment for a staff member,
-- independent of and unreachable by 139_owner_conflict_warn_confirm.sql's
-- check_and_reserve_slot logic:
--
-- 1. Removes the cross-business half of the check entirely (product
--    decision — a staff member linked to multiple businesses via
--    business_members.user_id could never be double-booked across them,
--    even before 139). That protection is no longer wanted: instead of a
--    hard block neither business can see the reason for, the plan is to
--    let the write through and surface a warning to the STAFF member
--    specifically (only they have visibility across both businesses),
--    with the ability to reject the offer — see the sprint doc. That
--    staff-facing warning/reject UX is a separate follow-up, not built by
--    this migration; this migration only removes the block.
--
--    get_available_slots does not need a matching change — the
--    cross-business awareness 027 originally gave it did not survive
--    later rewrites (042/049/089/113/126/137/139 all filter
--    `a.business_id = p_business_id` in their `booked` CTE), so
--    availability display has already been same-business-only for some
--    time regardless of this trigger.
--
-- 2. The same-business half of the check still applies by default, but now
--    honours a transaction-local escape hatch,
--    app.allow_staff_double_booking, which check_and_reserve_slot sets
--    immediately before proceeding past an owner-confirmed staff conflict
--    (139's p_confirm_conflict = true path). Without this, that
--    confirmation could never actually complete a write — this trigger
--    fired regardless of what check_and_reserve_slot decided, which is
--    exactly the gap that made 139's confirm-then-retry flow 500 with
--    STAFF_DOUBLE_BOOKED in CI instead of succeeding.
--
-- check_and_reserve_slot's parameter list is unchanged from 139 — only its
-- body gains one PERFORM — so no DROP FUNCTION is needed here (identical
-- argument types means CREATE OR REPLACE genuinely replaces it in place).
-- prevent_staff_double_bookings() has always taken zero arguments, so the
-- same applies there.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION prevent_staff_double_bookings()
RETURNS trigger AS $$
BEGIN
  IF NEW.staff_profile_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('cancelled', 'no_show') THEN
    RETURN NEW;
  END IF;

  IF NEW.ends_at <= NEW.starts_at THEN
    RAISE EXCEPTION 'INVALID_APPOINTMENT_RANGE'
      USING ERRCODE = '22007',
            DETAIL = 'ends_at must be greater than starts_at';
  END IF;

  -- Owner-confirmed override (139): the owner already saw and explicitly
  -- confirmed this specific staff conflict via check_and_reserve_slot's
  -- warn-then-confirm flow. Transaction-local (set with is_local = true in
  -- check_and_reserve_slot), so it can never leak past this one write.
  IF current_setting('app.allow_staff_double_booking', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM appointments a
    WHERE a.staff_profile_id = NEW.staff_profile_id
      AND a.status NOT IN ('cancelled', 'no_show')
      AND (TG_OP = 'INSERT' OR a.id <> NEW.id)
      AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  ) THEN
    RAISE EXCEPTION 'STAFF_DOUBLE_BOOKED'
      USING ERRCODE = '23P01',
            DETAIL = 'Overlapping appointment exists for this staff profile';
  END IF;

  -- Cross-business overlap is deliberately no longer checked here (product
  -- decision, 140) — see the migration header.

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── check_and_reserve_slot: tell the trigger to stand down on a confirmed
--    override ──────────────────────────────────────────────────────────────
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
      -- prevent_staff_double_bookings() (027/140) still runs its own
      -- unconditional same-business overlap check on the write that
      -- follows this PERFORM, independent of this function's own logic —
      -- tell it to stand down for this write specifically.
      PERFORM set_config('app.allow_staff_double_booking', 'true', true);
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
