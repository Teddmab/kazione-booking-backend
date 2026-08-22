-- 117_platform_alerts.sql
--
-- Platform-level (not tenant-scoped) error alerting, prompted by a real
-- incident: create-booking silently returned NOT_FOUND_FUNCTION_BLOB in
-- production for an unknown period before anyone noticed. Two pieces:
--
-- 1. platform_alert_settings — a singleton row holding the email address
--    platform admins want error/outage alerts sent to. Configured from the
--    admin portal (admin-alert-settings), not hardcoded — no alerts go out
--    until a platform admin sets this.
--
-- 2. platform_error_log — every 5xx response any edge function returns,
--    written by _shared/logger.ts's withLogging (fire-and-forget, mirrors
--    the existing admin_audit_log/staff_action_log/review_moderation_log
--    insert-only pattern). platform-alert-digest (a new CRON_SECRET-gated
--    cron function, mirrors send-reminders' scheduling) periodically emails
--    a summary of unnotified rows plus a health-check sweep of business-
--    critical endpoints, then marks the rows notified.

CREATE TABLE IF NOT EXISTS platform_alert_settings (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  alert_email text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO platform_alert_settings (id, alert_email)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE platform_alert_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_platform_alert_settings"
  ON platform_alert_settings FOR SELECT
  USING (is_platform_admin());

-- Inserts/updates come exclusively from admin-alert-settings via service
-- role (bypasses RLS). No user-facing INSERT/UPDATE/DELETE policies.

CREATE TABLE IF NOT EXISTS platform_error_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  function_name text        NOT NULL,
  method        text        NOT NULL,
  status_code   int         NOT NULL,
  message       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  notified_at   timestamptz
);

CREATE INDEX IF NOT EXISTS idx_platform_error_log_unnotified
  ON platform_error_log (created_at)
  WHERE notified_at IS NULL;

ALTER TABLE platform_error_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_platform_error_log"
  ON platform_error_log FOR SELECT
  USING (is_platform_admin());

-- Insert-only via service role (withLogging uses supabaseAdmin). Digest
-- updates (setting notified_at) also go through service role.

COMMENT ON TABLE platform_alert_settings IS
  'Singleton row (id=1). Where to email platform-wide error/outage alerts. Set from the admin portal only.';
COMMENT ON TABLE platform_error_log IS
  'Every 5xx response from any edge function, written by withLogging. Drained and marked notified by platform-alert-digest.';
