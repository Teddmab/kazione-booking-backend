-- ─────────────────────────────────────────────────────────────────────────────
-- 056_staff_position_service_commission.sql
--
-- Adds a free-text position label to staff_profiles (e.g. "Senior Stylist")
-- and per-service staff commission fields to services so owners can configure
-- automatic earnings calculation when a booking is assigned to a staff member.
-- ─────────────────────────────────────────────────────────────────────────────

-- Staff position / title (display label, e.g. "Barber", "Senior Stylist")
ALTER TABLE staff_profiles
  ADD COLUMN IF NOT EXISTS position text;

-- Per-service commission — type and value
-- type:  'none'       → fall back to staff_profiles.commission_rate
--        'percentage' → earned = price * value / 100
--        'fixed'      → earned = value (in business currency)
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS staff_commission_type text NOT NULL DEFAULT 'none'
    CHECK (staff_commission_type IN ('none', 'percentage', 'fixed')),
  ADD COLUMN IF NOT EXISTS staff_commission_value numeric(10, 2);
