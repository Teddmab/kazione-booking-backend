-- 127_appointment_completion_step1.sql
--
-- WEB-OWNER-APPOINTMENTS-02 (Step 1 of the "Complete appointment" wizard):
-- adds real backend support for an editable final price, a partial
-- "amount received" distinct from the appointment's booked price, and a
-- completion-draft record, so the new Payment step is functional rather
-- than a UI reskin over capabilities that don't exist.
--
-- final_price is nullable and deliberately separate from `price`: `price`
-- stays exactly what it was at booking time (the historical record this
-- migration is required to preserve), NULL final_price means "no
-- adjustment, use price as-is", and a non-null value is the authorized,
-- audited override actually charged. appointments/index.ts's completion
-- settlement and commission-snapshot logic read final_price ?? price.
--
-- appointment_price_log is the fourth instance of this codebase's
-- established one-small-table-per-actor-domain audit pattern (admin_audit_log,
-- staff_action_log, review_moderation_log) — modeled directly on
-- review_moderation_log (115_review_moderation.sql): append-only, mandatory
-- reason, owner/manager-only SELECT, inserts only via edge function service
-- role.
--
-- appointment_completion_drafts is a new pattern for this codebase: a
-- MUTABLE single-row-per-appointment draft (not an append-only log). It
-- lets "Save as draft" persist Step 1 state with zero operational side
-- effects (no stock/commission/payment mutation), and lets the wizard
-- rehydrate on reopen. payload is free-form jsonb so later steps (Products
-- used, Review) can extend it without another migration. Rows are deleted
-- by appointments/index.ts once the appointment is completed or cancelled,
-- so a draft never outlives the appointment state it was drafted against.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS final_price              numeric(10,2),
  ADD COLUMN IF NOT EXISTS final_price_adjusted_at   timestamptz,
  ADD COLUMN IF NOT EXISTS final_price_adjusted_by   uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE appointments
  ADD CONSTRAINT chk_appointments_final_price_nonneg
  CHECK (final_price IS NULL OR final_price >= 0);

COMMENT ON COLUMN appointments.final_price IS
  'Authorized price adjustment applied at completion time. NULL = no adjustment, use price unadjusted. Never overwrites price, which remains the original booking value. See appointment_price_log for the audit trail of changes.';
COMMENT ON COLUMN appointments.final_price_adjusted_at IS
  'When final_price was last changed. NULL if never adjusted.';
COMMENT ON COLUMN appointments.final_price_adjusted_by IS
  'User who last changed final_price. NULL if never adjusted.';

CREATE TABLE IF NOT EXISTS appointment_price_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id  uuid        NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  actor_user_id   uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  old_price       numeric(10,2) NOT NULL,
  new_price       numeric(10,2) NOT NULL,
  reason          text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appointment_price_log_business_time
  ON appointment_price_log (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_appointment_price_log_appointment
  ON appointment_price_log (appointment_id);

ALTER TABLE appointment_price_log ENABLE ROW LEVEL SECURITY;

-- Owner/manager of the business can read its log.
CREATE POLICY "business_read_appointment_price_log"
  ON appointment_price_log FOR SELECT
  USING (
    business_id IN (SELECT get_my_business_ids())
    AND get_user_role(business_id) IN ('owner', 'manager')
  );

-- Inserts come exclusively from edge functions via service role (bypasses
-- RLS). No user-facing INSERT, UPDATE, or DELETE policies — append-only.

COMMENT ON TABLE appointment_price_log IS
  'Tenant-scoped audit log of final-price adjustments made during appointment completion. Insert-only.';

CREATE TABLE IF NOT EXISTS appointment_completion_drafts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id  uuid        NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  actor_user_id   uuid        NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  step            text        NOT NULL DEFAULT 'payment',
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_appointment_completion_drafts_updated_at
  BEFORE UPDATE ON appointment_completion_drafts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_appointment_completion_drafts_business
  ON appointment_completion_drafts (business_id);

ALTER TABLE appointment_completion_drafts ENABLE ROW LEVEL SECURITY;

-- Owner/manager of the business can read the draft directly. get_user_role()
-- reflects business_members.role only ('owner'|'manager'|'staff') — supervisor
-- is a staff_profiles.is_supervisor flag, not a role value, so it can't be
-- expressed here the same way. Supervisor and assigned-staff-self access (both
-- already supported by appointments/index.ts's requireOwnerManagerOrSupervisorCtx
-- carve-out) go through the edge function's service role instead of a
-- client-facing INSERT/UPDATE policy, since "assigned staff for this specific
-- appointment" isn't expressible as a role check either.
CREATE POLICY "business_read_appointment_completion_drafts"
  ON appointment_completion_drafts FOR SELECT
  USING (
    business_id IN (SELECT get_my_business_ids())
    AND get_user_role(business_id) IN ('owner', 'manager')
  );

COMMENT ON TABLE appointment_completion_drafts IS
  'One mutable row per appointment holding in-progress "Complete appointment" wizard state (currently: Step 1/Payment fields). Not an audit log — rows are upserted while drafting and deleted once the appointment is completed or cancelled. No operational side effects (stock/commission/payment) result from a draft existing.';
COMMENT ON COLUMN appointment_completion_drafts.payload IS
  'Free-form step data, e.g. {final_price, price_adjustment_reason, amount_received_now, payment_method, payment_status, preset, confirmed}. Kept as jsonb so later wizard steps can extend it without a migration.';
