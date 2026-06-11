-- 045_admin_audit_log.sql
--
-- Immutable audit trail of every KaziOne platform admin action.
-- Insert-only from edge functions (service role); no UPDATE or DELETE allowed.
-- Never truncate this table.

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action        text        NOT NULL,
  -- Action values (defined in _shared/adminAudit.ts):
  --   STATS_VIEWED, BUSINESSES_LISTED, BUSINESS_VIEWED,
  --   BUSINESS_DISABLED, BUSINESS_ENABLED,
  --   APPOINTMENTS_LISTED, APPOINTMENT_VIEWED,
  --   USERS_LISTED, USER_VIEWED,
  --   PAYMENTS_LISTED, AUDIT_LOG_VIEWED
  target_type   text,       -- 'business' | 'user' | 'appointment' | 'payment' | null
  target_id     uuid,       -- primary key of the affected row
  target_meta   jsonb,      -- snapshot of key fields at time of action
  ip_address    inet,       -- forwarded from edge function CF-Connecting-IP header
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ──────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin_time
  ON admin_audit_log (admin_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit_log (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_admin_audit_action_time
  ON admin_audit_log (action, created_at DESC);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

-- Only platform admins can read their own audit trail
DROP POLICY IF EXISTS "admin_read_audit_log" ON admin_audit_log;
CREATE POLICY "admin_read_audit_log"
  ON admin_audit_log FOR SELECT
  USING (is_platform_admin());

-- Inserts come exclusively from edge functions via service role (bypasses RLS).
-- No user-facing INSERT, UPDATE, or DELETE policies — the log is append-only.

COMMENT ON TABLE admin_audit_log IS
  'Immutable audit log of all KaziOne platform admin actions. Never truncate or delete rows.';
