-- ─────────────────────────────────────────────────────────────────────────────
-- 004_staff_tables.sql  –  staff_profiles, staff_services, staff_working_hours,
--                          staff_time_off
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Staff Profiles ───────────────────────────────────────────────────────────
-- One row per stylist / team member within a business. Optionally linked to a
-- business_members row (when the staff member has a login); otherwise used for
-- display-only team members added by the owner.
CREATE TABLE staff_profiles (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  business_member_id  uuid REFERENCES business_members(id) ON DELETE SET NULL,
  display_name        text NOT NULL,
  bio                 text,
  avatar_url          text,
  specialties         text[] NOT NULL DEFAULT '{}',
  commission_rate     numeric(5,2) NOT NULL DEFAULT 0,   -- percentage
  calendar_color      text NOT NULL DEFAULT '#8B5CF6',
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_staff_profiles_business_active ON staff_profiles(business_id, is_active);
CREATE INDEX idx_staff_profiles_member          ON staff_profiles(business_member_id);

CREATE TRIGGER trg_staff_profiles_updated_at
  BEFORE UPDATE ON staff_profiles
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── Staff–Service mapping (many-to-many) ─────────────────────────────────────
-- Links staff members to the services they can perform. Optional overrides
-- for duration and price let a senior stylist charge more or work faster
-- without duplicating the service row.
CREATE TABLE staff_services (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_profile_id        uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  service_id              uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  custom_duration_minutes int,            -- NULL = use service default
  custom_price            numeric(10,2),  -- NULL = use service default
  UNIQUE (staff_profile_id, service_id)
);

CREATE INDEX idx_staff_services_staff   ON staff_services(staff_profile_id);
CREATE INDEX idx_staff_services_service ON staff_services(service_id);

-- ── Staff Working Hours ──────────────────────────────────────────────────────
-- One row per staff member per day of week. The availability engine reads these
-- rows to build bookable time slots. When is_working = false the day is a rest
-- day and start_time / end_time are ignored.
CREATE TABLE staff_working_hours (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_profile_id    uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day_of_week         int NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),  -- 0=Sun
  start_time          time,
  end_time            time,
  is_working          boolean NOT NULL DEFAULT true,
  UNIQUE (staff_profile_id, day_of_week),
  -- When the staff member is working, end_time must be after start_time
  CONSTRAINT chk_working_hours_range
    CHECK (is_working = false OR (start_time IS NOT NULL AND end_time IS NOT NULL AND end_time > start_time))
);

CREATE INDEX idx_working_hours_staff ON staff_working_hours(staff_profile_id);

-- ── Staff Time-Off ───────────────────────────────────────────────────────────
-- Ad-hoc blocked periods (holidays, sick days). The availability engine
-- excludes any slot that overlaps a time-off range.
CREATE TABLE staff_time_off (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  staff_profile_id    uuid NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_time_off_range CHECK (ends_at > starts_at)
);

CREATE INDEX idx_time_off_staff_range ON staff_time_off(staff_profile_id, starts_at, ends_at);
