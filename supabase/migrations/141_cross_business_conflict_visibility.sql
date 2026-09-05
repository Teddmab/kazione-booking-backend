-- ─────────────────────────────────────────────────────────────────────────────
-- 141_cross_business_conflict_visibility.sql
--
-- Follow-up to 140 (which removed the hard DB-level cross-business
-- double-booking block): a staff member linked to multiple businesses can
-- now be booked into overlapping appointments across them, but neither
-- business can see the conflict — only the staff member, who alone works
-- both places, has visibility into it. Product decision: surface it to
-- THEM, on the offer, with the ability to reject.
--
-- Mechanics:
--   - find_cross_business_conflict(p_staff_id, p_starts_at, p_ends_at,
--     p_exclude_appointment_id): given a staff member and a candidate
--     interval, returns the id of ONE conflicting appointment (if any) at
--     a DIFFERENT business linked to the same person via
--     business_members.user_id — same join shape 027's removed trigger
--     check used, just returning a value instead of raising.
--   - appointments.cross_business_conflict_appointment_id: a nullable
--     self-referencing FK set whenever that lookup finds something. Always
--     written explicitly (to the found id, or to NULL) on every relevant
--     write — reassigning a conflicted staff member to someone free must
--     clear a stale flag, not just leave it dangling.
--   - Three RPCs gain this detection, forcing status to 'offered' (the
--     existing staff-accept/reject mechanism, already used for referral
--     bookings) instead of whatever they'd otherwise have set, so a
--     conflicted assignment always requires the staff's own confirmation
--     before it's locked in:
--       - create_manual_appointment_atomic (owner manual booking)
--       - assign_staff_atomic (already defaults to 'offered' outside the
--         completed-appointment case — this adds the conflict reference
--         for the offer card without changing that existing status logic)
--       - reschedule_appointment_atomic (shared with the public
--         reschedule-booking self-service link — detection applies
--         regardless of caller, since a client's own reschedule can create
--         the same conflict for the staff member as an owner-initiated one)
--
-- Deliberately NOT touched here: create_booking_atomic (public new
-- bookings). It always inserts status='pending' regardless of staff or
-- conflicts, and public bookings never go through the offered/reject
-- lifecycle today — folding a conflicted public booking into 'offered'
-- would need its own look at payment-webhook and reserved-slot logic that
-- assumes 'pending' specifically. Left as a follow-up.
--
-- All three touched RPCs keep their exact 139/140 parameter lists — only
-- their bodies gain the lookup and a status override — so this is a plain
-- CREATE OR REPLACE, no DROP FUNCTION needed for any of them.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS cross_business_conflict_appointment_id uuid
    REFERENCES appointments(id) ON DELETE SET NULL;

COMMENT ON COLUMN appointments.cross_business_conflict_appointment_id IS
  'Set when this appointment''s staff member has another, overlapping '
  'appointment at a DIFFERENT business (linked via business_members.user_id). '
  'Only ever shown to that staff member themselves (appointments/index.ts '
  'gates it on the requester being this row''s own staff_profile_id) — an '
  'owner/manager of this business has no legitimate visibility into the '
  'other business the conflict belongs to.';

CREATE INDEX IF NOT EXISTS idx_appointments_cross_business_conflict
  ON appointments(cross_business_conflict_appointment_id)
  WHERE cross_business_conflict_appointment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION find_cross_business_conflict(
  p_staff_id                uuid,
  p_starts_at                timestamptz,
  p_ends_at                  timestamptz,
  p_exclude_appointment_id   uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT a.id
    FROM staff_profiles sp
    JOIN business_members bm  ON bm.id = sp.business_member_id
    JOIN business_members bm2 ON bm2.user_id = bm.user_id AND bm2.business_id <> sp.business_id
    JOIN staff_profiles sp2   ON sp2.business_member_id = bm2.id
    JOIN appointments a       ON a.staff_profile_id = sp2.id
   WHERE sp.id = p_staff_id
     AND a.status NOT IN ('cancelled', 'no_show')
     AND (p_exclude_appointment_id IS NULL OR a.id <> p_exclude_appointment_id)
     AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_starts_at, p_ends_at, '[)')
   ORDER BY a.starts_at
   LIMIT 1;
$$;

COMMENT ON FUNCTION find_cross_business_conflict IS
  'Returns the id of one overlapping appointment for p_staff_id''s linked '
  'person at a DIFFERENT business, or NULL. Used to populate '
  'appointments.cross_business_conflict_appointment_id — never raises, '
  'this is visibility, not a block (140 removed the hard block).';

-- ── create_manual_appointment_atomic: detect + force 'offered' ─────────────
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
  v_appointment_id     uuid;
  v_cross_conflict_id  uuid;
  v_final_status       text;
BEGIN
  PERFORM check_and_reserve_slot(
    p_business_id, p_staff_id, p_starts_at, p_ends_at, p_buffer_minutes, NULL,
    'create_manual_appointment_atomic', true, p_confirm_conflict
  );

  v_cross_conflict_id := find_cross_business_conflict(p_staff_id, p_starts_at, p_ends_at, NULL);
  v_final_status := CASE WHEN v_cross_conflict_id IS NOT NULL THEN 'offered' ELSE p_status END;

  INSERT INTO appointments (
    business_id, client_id, service_id, staff_profile_id,
    starts_at, ends_at, duration_minutes,
    price, deposit_amount, booking_source, booking_reference,
    is_walk_in, notes, internal_notes, status,
    cross_business_conflict_appointment_id
  ) VALUES (
    p_business_id, p_client_id, p_service_id, p_staff_id,
    p_starts_at, p_ends_at, p_duration_minutes,
    p_price, p_deposit_amount, p_booking_source::booking_source, p_booking_reference,
    p_is_walk_in, p_notes, p_internal_notes, v_final_status::appointment_status,
    v_cross_conflict_id
  ) RETURNING id INTO v_appointment_id;

  RETURN v_appointment_id;
END;
$$;

-- ── assign_staff_atomic: detect + record (status logic unchanged) ─────────
-- The caller (appointments/index.ts) already sets p_new_status='offered'
-- for any live (non-completed) reassignment — this just makes sure the
-- conflict reference is attached (or cleared) so the offer card can show
-- it, without changing that existing status decision.
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
  v_business_id        uuid;
  v_starts_at          timestamptz;
  v_ends_at            timestamptz;
  v_buffer_minutes     int;
  v_cross_conflict_id  uuid;
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

  v_cross_conflict_id := find_cross_business_conflict(p_staff_id, v_starts_at, v_ends_at, p_appointment_id);

  UPDATE appointments
     SET staff_profile_id = p_staff_id,
         status = p_new_status::appointment_status,
         cross_business_conflict_appointment_id = v_cross_conflict_id
   WHERE id = p_appointment_id;
END;
$$;

-- ── reschedule_appointment_atomic: detect + force 'offered' ────────────────
-- Applies to BOTH callers (owner dashboard and the public reschedule-
-- booking self-service link) — a client's own reschedule can create the
-- same cross-business conflict for the staff member as an owner-initiated
-- one, so this is independent of p_allow_confirm.
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
  v_business_id        uuid;
  v_buffer_minutes     int;
  v_cross_conflict_id  uuid;
  v_final_status       text;
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

  v_cross_conflict_id := find_cross_business_conflict(p_new_staff_id, p_new_starts_at, p_new_ends_at, p_appointment_id);
  v_final_status := CASE WHEN v_cross_conflict_id IS NOT NULL THEN 'offered' ELSE 'confirmed' END;

  UPDATE appointments
     SET starts_at = p_new_starts_at,
         ends_at = p_new_ends_at,
         staff_profile_id = p_new_staff_id,
         status = v_final_status::appointment_status,
         cross_business_conflict_appointment_id = v_cross_conflict_id
   WHERE id = p_appointment_id;
END;
$$;
