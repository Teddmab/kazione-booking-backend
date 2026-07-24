-- ── Staff Service Offers ─────────────────────────────────────────────────────
-- When an owner assigns a service to a staff member, the row starts as
-- 'pending'. The staff member must explicitly accept before the service
-- appears in their booking slots. The owner can attach a per-assignment
-- commission that overrides the service-level default.

ALTER TABLE staff_services
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('pending', 'accepted', 'declined')),
  ADD COLUMN IF NOT EXISTS offered_commission_type  text
    CHECK (offered_commission_type IN ('none', 'percentage', 'fixed')),
  ADD COLUMN IF NOT EXISTS offered_commission_value numeric(10,2),
  ADD COLUMN IF NOT EXISTS assigned_at   timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS responded_at  timestamptz;

CREATE INDEX IF NOT EXISTS idx_staff_services_status
  ON staff_services(status);
