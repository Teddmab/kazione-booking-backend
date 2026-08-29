-- 131_platform_storefront_launch_config.sql
--
-- Platform-level (not tenant-scoped) launch countdown configuration for the
-- WEB-CLIENT-LANDING-01 client landing-page redesign.
--
-- Deliberately minimal: only the launch date/timezone/countdown-visibility
-- are admin-managed. Everything else on the landing page (hero copy/images,
-- CTA destinations, Beauty Shop / Quick Service / early-access status) is
-- fixed default content shipped in the client itself, not admin-editable —
-- narrowed from an earlier, broader draft/publish/hero-slide design after
-- product review found that surface too large for what's actually needed.
--
-- Singleton row (id=1), same shape as platform_alert_settings: a direct
-- GET/PATCH from the admin portal, no draft/publish ceremony.

CREATE TABLE IF NOT EXISTS platform_storefront_launch_config (
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

-- The public storefront-launch-config function (no auth) reads this via
-- service role, which already bypasses RLS — no extra policy needed.

COMMENT ON TABLE platform_storefront_launch_config IS
  'Singleton row (id=1). Admin-managed launch date/timezone/countdown visibility for the client landing page. Everything else on that page is fixed client-side content.';
