-- 135_admin_audit_log_column_backfill.sql
--
-- Production incident: GET /admin-audit-log started returning 500
-- "column admin_audit_log.target_meta does not exist". target_meta has
-- been part of 045_admin_audit_log.sql's CREATE TABLE IF NOT EXISTS since
-- that migration was first written — but IF NOT EXISTS is a no-op against
-- a pre-existing, differently-shaped table, so if admin_audit_log was ever
-- created (by an earlier version of that migration, or some other path)
-- before target_meta was added to the file, the live table silently never
-- picked up the column. This is the same class of drift already found in
-- platform_storefront_launch_config (migration 134) — except this table is
-- explicitly documented "Never truncate this table" (it holds real audit
-- history), so the fix here is additive ALTER TABLE, never DROP/recreate.
--
-- Idempotent — safe to run regardless of which of these columns the live
-- table is actually missing.

ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_type text;
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_id uuid;
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS target_meta jsonb;
ALTER TABLE admin_audit_log ADD COLUMN IF NOT EXISTS ip_address inet;

CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit_log (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_admin_audit_action_time
  ON admin_audit_log (action, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_admin_time
  ON admin_audit_log (admin_id, created_at DESC);
