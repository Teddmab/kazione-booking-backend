-- 133_platform_storefront_launch_config_reset.sql
--
-- Migration 131 was edited in place between two merged PRs (#218's original
-- broad draft/published/version schema, then #220's narrower
-- launch_at/launch_timezone/countdown_visible schema) instead of being left
-- immutable and superseded by a new migration — a process mistake. Because
-- the repo's deploy pipeline had been silently failing to push migrations
-- since well before either PR (a separate, pre-existing IPv6/pooler-auth
-- issue on GitHub-hosted runners), the actual applied-migration history and
-- physical table shape on the remote database is uncertain, and
-- `CREATE TABLE IF NOT EXISTS` (used by 131) is a no-op if a
-- differently-shaped table already exists under that name.
--
-- This migration unconditionally resets platform_storefront_launch_config
-- to the correct (narrow) shape regardless of whatever state it's actually
-- in — safe because the table has never held anything but a single default
-- config row (no tenant/user data at risk).
--
-- Going forward: once merged, a migration file's content is immutable.
-- Any further schema change is a new migration, never an edit to this one.

DROP TABLE IF EXISTS platform_storefront_launch_config;

CREATE TABLE platform_storefront_launch_config (
  id                int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  launch_at         timestamptz,
  launch_timezone   text,
  countdown_visible boolean NOT NULL DEFAULT false,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO platform_storefront_launch_config (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE platform_storefront_launch_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_storefront_launch_config"
  ON platform_storefront_launch_config FOR SELECT
  USING (is_platform_admin());

CREATE POLICY "admin_update_storefront_launch_config"
  ON platform_storefront_launch_config FOR UPDATE
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

COMMENT ON TABLE platform_storefront_launch_config IS
  'Singleton row (id=1). Admin-managed launch date/timezone/countdown visibility for the client landing page. Everything else on that page is fixed client-side content.';
