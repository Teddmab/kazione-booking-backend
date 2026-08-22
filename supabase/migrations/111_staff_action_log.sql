-- 111_staff_action_log.sql
--
-- Business-scoped (tenant-level) audit trail for sensitive owner/manager
-- actions on staff accounts — starting with the staff magic-link action,
-- which lets an owner/manager mint a live sign-in link for any staff member
-- in their business. admin_audit_log (045) is platform-admin-only and does
-- not cover this; this table is its per-tenant equivalent.
--
-- Insert-only from edge functions (service role); no UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS staff_action_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  actor_user_id   uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action          text        NOT NULL,
  -- Action values:
  --   STAFF_MAGIC_LINK_ISSUED
  staff_profile_id uuid       REFERENCES staff_profiles(id) ON DELETE SET NULL,
  target_meta     jsonb,      -- snapshot of relevant context at time of action
  ip_address      inet,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_staff_action_log_business_time
  ON staff_action_log (business_id, created_at DESC);

CREATE INDEX idx_staff_action_log_staff
  ON staff_action_log (staff_profile_id);

ALTER TABLE staff_action_log ENABLE ROW LEVEL SECURITY;

-- Owner/manager of the business can read its log.
CREATE POLICY "business_read_staff_action_log"
  ON staff_action_log FOR SELECT
  USING (
    business_id IN (SELECT get_my_business_ids())
    AND get_user_role(business_id) IN ('owner', 'manager')
  );

-- Inserts come exclusively from edge functions via service role (bypasses
-- RLS). No user-facing INSERT, UPDATE, or DELETE policies — append-only.

COMMENT ON TABLE staff_action_log IS
  'Tenant-scoped audit log of sensitive owner/manager actions on staff accounts. Insert-only.';
