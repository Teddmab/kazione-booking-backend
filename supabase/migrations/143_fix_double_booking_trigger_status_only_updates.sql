-- ─────────────────────────────────────────────────────────────────────────────
-- 143_fix_double_booking_trigger_status_only_updates.sql
--
-- prevent_staff_double_bookings() (027, rewritten by 140) fires on
-- `UPDATE OF staff_profile_id, starts_at, ends_at, status` — status is in
-- that list so the trigger re-runs its overlap check on EVERY status
-- change, not just when the staff or time actually changes. Once 139/140
-- legitimately allow one staff member to hold two overlapping appointments
-- (an owner-confirmed override, or a staff member accepting a cross-
-- business-conflict offer, 141), that tolerated conflict is still sitting
-- in the table — so the very next status-only update to EITHER
-- appointment (completing it, accepting an offer into 'confirmed', marking
-- in_progress, pending_completion, ...) re-finds the same overlap and hard
-- -blocks with a raw STAFF_DOUBLE_BOOKED 500, even though nothing about
-- who or when is changing.
--
-- Fix: skip the overlap re-check on an UPDATE where staff_profile_id,
-- starts_at and ends_at are all unchanged from OLD — a pure status/field
-- update can't introduce a NEW conflict, so there's nothing to validate.
-- The one deliberate exception is un-cancelling (OLD status was
-- cancelled/no_show, NEW status isn't) with the schedule otherwise
-- unchanged: that case still re-validates, since a real conflict may have
-- appeared for that same slot while this appointment was cancelled.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.prevent_staff_double_bookings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- A pure status/field update that doesn't touch WHO or WHEN can't
  -- introduce a new conflict — see migration header.
  IF TG_OP = 'UPDATE'
     AND NEW.staff_profile_id IS NOT DISTINCT FROM OLD.staff_profile_id
     AND NEW.starts_at = OLD.starts_at
     AND NEW.ends_at   = OLD.ends_at
     AND NOT (OLD.status IN ('cancelled', 'no_show') AND NEW.status NOT IN ('cancelled', 'no_show'))
  THEN
    RETURN NEW;
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
$$;
