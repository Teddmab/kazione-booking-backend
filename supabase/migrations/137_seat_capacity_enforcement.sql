-- ─────────────────────────────────────────────────────────────────────────────
-- 137_seat_capacity_enforcement.sql
--
-- SPRINT: Salon Seat Capacity — Stage 2 (pilot-only real enforcement).
-- See team/FRONTEND/OWNER/KAZIONE_SPRINT_OWNER_PORTAL_SEAT_CAPACITY.md.
-- Builds on 136_seat_capacity_shadow.sql (Stage 1: config + shadow logging,
-- never rejects). Design decisions confirmed with the owner before writing
-- this migration:
--
--   1. business_settings.seat_capacity_enabled keeps its Stage 1 meaning
--      ("shadow logging configured/active") untouched. A NEW column,
--      seat_capacity_enforced, means "actually reject over-capacity
--      bookings" — additive, so no business that already enabled shadow
--      mode is silently upgraded to real blocking.
--   2. Pilot-only reach is a data table (capacity_enforcement_pilot_businesses),
--      not a hardcoded id in application code — seeded with Afrotouch only.
--      Real enforcement requires ALL THREE: seat_capacity_enabled,
--      seat_capacity_enforced, and business_id present in this table.
--   3. appointment_capacity_shadow_log gains an `outcome` column
--      ('logged_only' | 'rejected') instead of a parallel log table — same
--      row shape, so Stage 1's existing shadow-mode rows and reporting are
--      unaffected (outcome defaults to 'logged_only').
--
-- Every one of the six atomic RPCs keeps its exact pre-existing signature —
-- same reasoning as 136: a real signature change silently creates a second
-- pg_proc overload instead of replacing the original. get_available_slots
-- also keeps its exact signature; it previously had zero capacity awareness
-- (136 only touched check_and_reserve_slot), so this is the first migration
-- to teach it about capacity at all.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. business_settings: enforcement flag, additive to Stage 1's flag ──────
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS seat_capacity_enforced boolean NOT NULL DEFAULT false
    CONSTRAINT chk_seat_capacity_enforced_requires_enabled
      CHECK (NOT seat_capacity_enforced OR seat_capacity_enabled);

COMMENT ON COLUMN business_settings.seat_capacity_enforced IS
  'Stage 2 (pilot-only): when true (together with seat_capacity_enabled AND '
  'this business_id being present in capacity_enforcement_pilot_businesses), '
  'check_and_reserve_slot actually rejects bookings that would exceed '
  'seat_count, and get_available_slots stops offering times that would. '
  'False for every business outside the pilot, regardless of this flag, '
  'because capacity_enforcement_pilot_businesses gates it independently.';

-- ── 2. capacity_enforcement_pilot_businesses: pilot allowlist as data ───────
-- Deliberately a table, not a hardcoded business_id check in application
-- code, so widening the pilot later is an INSERT, not a deploy. No RLS
-- policies are defined — this table is never read from client-facing code,
-- only from inside SECURITY DEFINER functions below (which run as the
-- table owner and so bypass RLS, the same reason
-- appointment_capacity_shadow_log's insert-only table needs no INSERT
-- policy). RLS is still enabled so a future PostgREST grant mistake fails
-- closed instead of silently exposing the table.
CREATE TABLE IF NOT EXISTS capacity_enforcement_pilot_businesses (
  business_id  uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  added_at     timestamptz NOT NULL DEFAULT now(),
  note         text
);

ALTER TABLE capacity_enforcement_pilot_businesses ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE capacity_enforcement_pilot_businesses IS
  'Stage 2 pilot allowlist: a business_id here is ELIGIBLE for real seat-'
  'capacity enforcement, but enforcement still requires that business''s own '
  'business_settings.seat_capacity_enabled AND seat_capacity_enforced to '
  'both be true. Widen the pilot by inserting a row here, never by editing '
  'application code.';

-- This literal is the LOCAL/CI seed business id, not any real business's
-- production id (which is generated at signup and unknown at migration-
-- write time) — SELECT ... WHERE EXISTS instead of a plain INSERT VALUES so
-- this is a no-op wherever that seed id doesn't exist (every non-seeded
-- environment, including production) instead of a hard FK-violation
-- failure that blocks every migration after it. Enrolling the real
-- production Afrotouch business is a one-time data operation, not a
-- migration — see the table comment above.
INSERT INTO capacity_enforcement_pilot_businesses (business_id, note)
SELECT id, 'Afrotouch — Salon Seat Capacity pilot customer'
  FROM businesses
 WHERE id = 'b0000000-0000-4000-8000-000000000001'
ON CONFLICT (business_id) DO NOTHING;

-- ── 3. appointment_capacity_shadow_log: record the real outcome ────────────
ALTER TABLE appointment_capacity_shadow_log
  ADD COLUMN IF NOT EXISTS outcome text NOT NULL DEFAULT 'logged_only'
    CONSTRAINT chk_capacity_shadow_log_outcome
      CHECK (outcome IN ('logged_only', 'rejected'));

COMMENT ON COLUMN appointment_capacity_shadow_log.outcome IS
  '''logged_only'' = Stage 1 behaviour, booking still succeeded (business not '
  'pilot-enforced). ''rejected'' = Stage 2 enforcement actually blocked this '
  'booking attempt (SEAT_CAPACITY_EXCEEDED).';

-- ── 4. check_and_reserve_slot: enforce for pilot-enforced businesses ────────
-- Exact pre-existing signature (unchanged since 136) — only the body's
-- capacity section changes: it now looks up whether this business is
-- actually pilot-enforced and, if so, raises instead of only logging.
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
    RAISE EXCEPTION 'SLOT_TAKEN: The selected time slot is no longer available';
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
      SELECT EXISTS (
        SELECT 1 FROM capacity_enforcement_pilot_businesses peb
         WHERE peb.business_id = p_business_id
      ) INTO v_is_pilot_business;

      v_enforce := v_seat_capacity_enforced IS TRUE AND v_is_pilot_business IS TRUE;

      IF v_enforce THEN
        -- Do NOT insert here: RAISE EXCEPTION aborts this entire
        -- transaction, which would roll back that insert right along with
        -- everything else (Postgres has no autonomous-transaction
        -- primitive without dblink/pg_background, neither of which this
        -- project uses). The structured detail a caller needs to log the
        -- rejection AFTER this transaction has already aborted travels on
        -- the exception itself — PostgREST surfaces Postgres's DETAIL as
        -- err.details — and _shared/seatCapacityLog.ts writes the actual
        -- 'rejected' row from the edge function, once the RPC call returns.
        RAISE EXCEPTION 'SEAT_CAPACITY_EXCEEDED: This time is no longer available'
          USING DETAIL = json_build_object(
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
          v_seat_count, v_overlapping_count, true, p_source, 'logged_only'
        );
      END IF;
    END IF;
  END IF;
END;
$$;

-- ── 5. get_available_slots: stop offering times that would exceed capacity ─
-- Exact pre-existing signature (unchanged since 126). Previously had zero
-- capacity awareness — capacity was only ever checked at write time inside
-- check_and_reserve_slot (136). This is business-wide, independent of which
-- staff member the slot belongs to: the same instant is either over
-- capacity for everyone or for no one, so every eligible staff member's row
-- at that instant is filtered identically.
CREATE OR REPLACE FUNCTION get_available_slots(
  p_business_id uuid,
  p_service_id  uuid,
  p_staff_id    uuid DEFAULT NULL,
  p_date        date DEFAULT CURRENT_DATE,
  p_min_staff   int  DEFAULT 1
)
RETURNS TABLE (
  slot_time        time,
  staff_profile_id uuid,
  staff_name       text,
  custom_price     numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_duration               int;
  v_slot_interval          int;
  v_lead_hours             int;
  v_future_days            int;
  v_earliest_time          timestamptz;
  v_max_date               date;
  v_business_tz            text;
  v_day_start_utc          timestamptz;
  v_day_end_utc            timestamptz;
  v_capacity_enforced      boolean;
  v_seat_count             int;
BEGIN
  SELECT s.duration_minutes
    INTO v_duration
    FROM services s
   WHERE s.id = p_service_id
     AND s.business_id = p_business_id
     AND s.is_active = true;

  IF v_duration IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(bs.slot_duration_minutes, 30),
         COALESCE(bs.booking_lead_time_hours, 2),
         COALESCE(bs.booking_future_days, 60),
         (bs.seat_capacity_enabled IS TRUE AND bs.seat_capacity_enforced IS TRUE
           AND EXISTS (
             SELECT 1 FROM capacity_enforcement_pilot_businesses peb
              WHERE peb.business_id = p_business_id
           )),
         bs.seat_count
    INTO v_slot_interval, v_lead_hours, v_future_days, v_capacity_enforced, v_seat_count
    FROM business_settings bs
   WHERE bs.business_id = p_business_id;

  v_slot_interval     := COALESCE(v_slot_interval, 30);
  v_lead_hours        := COALESCE(v_lead_hours, 2);
  v_future_days       := COALESCE(v_future_days, 60);
  v_capacity_enforced := COALESCE(v_capacity_enforced, false) AND v_seat_count IS NOT NULL;

  SELECT COALESCE(b.timezone, 'UTC')
    INTO v_business_tz
    FROM businesses b
   WHERE b.id = p_business_id;
  v_business_tz := COALESCE(v_business_tz, 'UTC');

  v_max_date := CURRENT_DATE + v_future_days;
  IF p_date > v_max_date THEN
    RETURN;
  END IF;

  v_earliest_time := now() + (v_lead_hours || ' hours')::interval;
  v_day_start_utc := (p_date::timestamp AT TIME ZONE v_business_tz);
  v_day_end_utc   := ((p_date + 1)::timestamp AT TIME ZONE v_business_tz);

  RETURN QUERY
  WITH eligible_staff AS (
    SELECT sp.id   AS sp_id,
           sp.display_name,
           COALESCE(ss.custom_price, srv.price) AS eff_price
      FROM staff_services ss
      JOIN staff_profiles sp  ON sp.id  = ss.staff_profile_id
      JOIN services       srv ON srv.id = ss.service_id
     WHERE ss.service_id  = p_service_id
       AND sp.business_id = p_business_id
       AND sp.is_active   = true
       AND ss.status       = 'accepted'
       AND (ss.effective_date IS NULL OR ss.effective_date <= p_date)
       AND (p_staff_id IS NULL OR sp.id = p_staff_id)
  ),
  staff_hours AS (
    SELECT es.sp_id,
           es.display_name,
           es.eff_price,
           wh.start_time AS wh_start,
           wh.end_time   AS wh_end
      FROM eligible_staff es
      JOIN staff_working_hours wh
        ON wh.staff_profile_id = es.sp_id
       AND wh.day_of_week = EXTRACT(DOW FROM p_date)::int
       AND wh.is_working  = true
  ),
  slot_series AS (
    SELECT sh.sp_id,
           sh.display_name,
           sh.eff_price,
           gs AS s_instant
      FROM staff_hours sh,
           generate_series(
             ((p_date + sh.wh_start) AT TIME ZONE v_business_tz),
             ((p_date + sh.wh_end) AT TIME ZONE v_business_tz)
               - (v_duration || ' minutes')::interval,
             (v_slot_interval || ' minutes')::interval
           ) gs
  ),
  booked AS (
    SELECT a.staff_profile_id AS sp_id,
           a.starts_at,
           a.ends_at
      FROM appointments a
     WHERE a.business_id = p_business_id
       AND a.starts_at   < v_day_end_utc
       AND a.ends_at     > v_day_start_utc
       AND a.status NOT IN ('cancelled', 'no_show')
  ),
  time_off AS (
    SELECT sto.staff_profile_id AS sp_id,
           sto.starts_at,
           sto.ends_at
      FROM staff_time_off sto
     WHERE sto.business_id = p_business_id
       AND sto.starts_at   < v_day_end_utc
       AND sto.ends_at     > v_day_start_utc
  ),
  free_slots AS (
    SELECT ss.s_instant, ss.sp_id, ss.display_name, ss.eff_price
      FROM slot_series ss
     WHERE
       NOT EXISTS (
         SELECT 1 FROM booked b
          WHERE b.sp_id = ss.sp_id
            AND ss.s_instant                                        < b.ends_at
            AND (ss.s_instant + (v_duration || ' minutes')::interval) > b.starts_at
       )
       AND NOT EXISTS (
         SELECT 1 FROM time_off toff
          WHERE toff.sp_id = ss.sp_id
            AND ss.s_instant                                        < toff.ends_at
            AND (ss.s_instant + (v_duration || ' minutes')::interval) > toff.starts_at
       )
       AND ss.s_instant >= v_earliest_time
       -- Business-wide seat capacity (pilot-enforced businesses only):
       -- how many non-cancelled/no_show/completed appointments already
       -- occupy this exact instant, regardless of staff — same counting
       -- rule as check_and_reserve_slot's shadow/enforcement check.
       AND (
         NOT v_capacity_enforced
         OR (
           SELECT COUNT(*)
             FROM appointments a
            WHERE a.business_id = p_business_id
              AND a.status NOT IN ('cancelled', 'no_show', 'completed')
              AND a.starts_at < (ss.s_instant + (v_duration || ' minutes')::interval)
              AND a.ends_at   > ss.s_instant
         ) < v_seat_count
       )
  ),
  slot_counts AS (
    SELECT s_instant, COUNT(*) AS free_count
      FROM free_slots
     GROUP BY s_instant
  )
  SELECT DISTINCT
         (fs.s_instant AT TIME ZONE v_business_tz)::time AS slot_time,
         fs.sp_id         AS staff_profile_id,
         fs.display_name  AS staff_name,
         fs.eff_price     AS custom_price
    FROM free_slots fs
    JOIN slot_counts sc ON sc.s_instant = fs.s_instant
   WHERE sc.free_count >= p_min_staff
   -- ORDER BY must use the SELECT list's own expressions for SELECT DISTINCT
   -- (Postgres 42P10) — slot_time is a transformed expression (AT TIME ZONE
   -- + ::time cast), not the raw fs.s_instant/fs.sp_id columns, so order by
   -- the output aliases instead. Safe: within one calendar day, local
   -- time-of-day ordering is monotonic with the underlying instant ordering.
   ORDER BY slot_time, staff_profile_id;
END;
$$;
