-- ─────────────────────────────────────────────────────────────────────────────
-- 126 — Owner Services redesign (WEB-OWNER-SERVICES-01): team assignment fields,
-- draft status, service activity log, and a booking-engine correctness fix.
--
-- staff_services gains a 'withdrawn' status (owner-initiated offer pull,
-- distinct from staff-initiated 'declined' — both must be preserved for the
-- new Team tab/Activity feed instead of the current hard-delete-on-omit
-- behaviour), a per-assignment role ('primary'/'secondary', reusing the
-- existing requires_two_staff/commission_split_pct dual-staff model rather
-- than a free-text taxonomy), and an effective_date.
--
-- services gains a 'status' column ('draft'/'active') so the Add/Edit wizard
-- can persist real partial rows and resume them, without touching the
-- existing is_active/is_public visibility flags get-storefront already reads.
--
-- service_activity_log is a new append-only table (same no-UPDATE/DELETE
-- pattern as stock_movements) backing the Activity tab with real events
-- instead of a fabricated audit trail.
--
-- get_available_slots is corrected: its eligible_staff CTE has always
-- filtered only on staff_profiles.is_active, never on staff_services.status,
-- so a staff member with a still-pending or already-declined offer could be
-- booked publicly. The new Team tab makes an explicit "accepted-only
-- bookability" promise, so this bug must be fixed here, not carried forward.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── staff_services: withdrawn status, role, effective date ─────────────────

ALTER TABLE staff_services DROP CONSTRAINT IF EXISTS staff_services_status_check;
ALTER TABLE staff_services
  ADD CONSTRAINT staff_services_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn'));

ALTER TABLE staff_services
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'primary'
    CHECK (role IN ('primary', 'secondary')),
  ADD COLUMN IF NOT EXISTS effective_date date;

COMMENT ON COLUMN staff_services.role IS
  'Which dual-staff slot this assignment fills when the service requires two staff (services.requires_two_staff). Always ''primary'' for single-staff services.';
COMMENT ON COLUMN staff_services.effective_date IS
  'NULL = effective immediately. When set, get_available_slots only treats this assignment as eligible on/after this date.';

-- ── services: draft status ──────────────────────────────────────────────────

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active'));

CREATE INDEX IF NOT EXISTS idx_services_business_status ON services(business_id, status);

COMMENT ON COLUMN services.status IS
  'draft = wizard-in-progress, always forced is_active=false server-side. active = normal service, visibility still governed by is_active/is_public.';

-- ── service_activity_log: append-only, mirrors stock_movements RLS shape ───

CREATE TABLE service_activity_log (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  service_id    uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type    text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE service_activity_log IS
  'Append-only event feed backing the owner Services detail modal''s Activity tab. event_type: service_created | service_updated | visibility_changed | archived | restored | offer_sent | offer_accepted | offer_declined | offer_withdrawn | product_usage_added | product_usage_removed | product_usage_updated.';

CREATE INDEX idx_service_activity_log_service  ON service_activity_log(service_id, created_at DESC);
CREATE INDEX idx_service_activity_log_business ON service_activity_log(business_id, created_at DESC);

ALTER TABLE service_activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY sal_select ON service_activity_log FOR SELECT
  USING (get_user_role(business_id) IN ('owner', 'manager'));

CREATE POLICY sal_insert ON service_activity_log FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));

-- service_activity_log is append-only; no UPDATE or DELETE policies.

-- ── get_available_slots: honor accepted-only + effective_date ──────────────
-- Identical to 113_get_available_slots_timezone_aware.sql except the
-- eligible_staff CTE. No signature change — every existing caller
-- (create-booking, get-availability, reschedule-booking) is unaffected.

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
  v_duration       int;
  v_slot_interval  int;
  v_lead_hours     int;
  v_future_days    int;
  v_earliest_time  timestamptz;
  v_max_date       date;
  v_business_tz    text;
  v_day_start_utc  timestamptz;
  v_day_end_utc    timestamptz;
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
         COALESCE(bs.booking_future_days, 60)
    INTO v_slot_interval, v_lead_hours, v_future_days
    FROM business_settings bs
   WHERE bs.business_id = p_business_id;

  v_slot_interval := COALESCE(v_slot_interval, 30);
  v_lead_hours    := COALESCE(v_lead_hours, 2);
  v_future_days   := COALESCE(v_future_days, 60);

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
   ORDER BY slot_time, staff_profile_id;
END;
$$;
