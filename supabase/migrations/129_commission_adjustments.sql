-- 129_commission_adjustments.sql
--
-- SPRINT_S48 (Commission Correction Workflow): since migration
-- 124_commission_completion_snapshot.sql, a completed appointment's
-- commission is frozen at commission_amount_snapshot[_2] and correctly
-- immune to later edits of the service's commission rate. But there was no
-- way to correct that snapshot when it was wrong in the first place (bad
-- rate configured at the moment of completion, mis-credited staff, etc.) —
-- the only lever was mark_commission_paid, which takes an arbitrary amount
-- with no required reason and writes no audit trail.
--
-- appointment_commission_adjustments is the fifth instance of this
-- codebase's one-small-table-per-actor-domain audit pattern (admin_audit_log,
-- staff_action_log, review_moderation_log, appointment_price_log) — modeled
-- directly on appointment_price_log (127_appointment_completion_step1.sql):
-- append-only, mandatory reason, owner/manager-only SELECT, inserts only via
-- edge function service role.
--
-- Each row records an absolute before/after pair for one correction event,
-- not a delta — so the "current payable" amount for a given
-- (appointment_id, staff_profile_id) is the new_amount of its most recent
-- adjustment row, falling back to appointments.commission_amount_snapshot[_2]
-- when no adjustment exists yet. commission_amount_snapshot[_2] itself is
-- never overwritten, preserving the original completion-time record.

CREATE TABLE IF NOT EXISTS appointment_commission_adjustments (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid          NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id    uuid          NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  staff_profile_id  uuid          NOT NULL REFERENCES staff_profiles(id) ON DELETE RESTRICT,
  previous_amount   numeric(10,2) NOT NULL,
  new_amount        numeric(10,2) NOT NULL,
  reason            text          NOT NULL,
  adjusted_by       uuid          NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT chk_commission_adjustment_amounts_nonneg
    CHECK (previous_amount >= 0 AND new_amount >= 0),
  CONSTRAINT chk_commission_adjustment_reason_not_blank
    CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_commission_adjustments_business_time
  ON appointment_commission_adjustments (business_id, created_at DESC);

-- Lets the edge function fetch "latest adjustment per (appointment, staff)"
-- efficiently for both the correction endpoint (previous_amount lookup) and
-- the commission-ledger reads (current-payable lookup).
CREATE INDEX IF NOT EXISTS idx_commission_adjustments_appt_staff
  ON appointment_commission_adjustments (appointment_id, staff_profile_id, created_at DESC);

ALTER TABLE appointment_commission_adjustments ENABLE ROW LEVEL SECURITY;

-- Owner/manager of the business can read its log.
CREATE POLICY "business_read_commission_adjustments"
  ON appointment_commission_adjustments FOR SELECT
  USING (
    business_id IN (SELECT get_my_business_ids())
    AND get_user_role(business_id) IN ('owner', 'manager')
  );

-- Inserts come exclusively from edge functions via service role (bypasses
-- RLS). No user-facing INSERT, UPDATE, or DELETE policies — append-only.

COMMENT ON TABLE appointment_commission_adjustments IS
  'Tenant-scoped audit log of manual corrections to a completed appointment''s frozen commission amount. Insert-only; each row is an absolute previous/new pair for one correction event, not a delta. The original appointments.commission_amount_snapshot[_2] is never overwritten — the current payable amount for a (appointment_id, staff_profile_id) pair is this table''s most recent new_amount, falling back to the original snapshot when no correction exists.';
