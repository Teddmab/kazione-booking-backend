-- 131_platform_storefront_launch_config.sql
--
-- Platform-level (not tenant-scoped) storefront launch/countdown configuration,
-- for the WEB-CLIENT-LANDING-01 client landing-page redesign.
--
-- Singleton row (id=1) holding two full JSONB config snapshots:
--   draft     — always writable via admin-storefront-launch-config PATCH
--   published — only ever set by POST ?action=publish, which copies draft
--               into it after validation; this is what the public
--               storefront-launch-config endpoint reads. Editing the draft
--               after publishing does NOT change what's live until the next
--               publish — this is what makes "save draft" and "publish"
--               distinct operations instead of one and the same.
--
-- Config shape (validated in the edge function, not the DB — JSONB has no
-- schema enforcement, matching how services/offers validate in-function):
--   {
--     launchAt: string (ISO 8601 instant) | null,
--     launchTimezone: string (IANA zone) | null,
--     countdownVisible: boolean,
--     earlyAccessEnabled: boolean,
--     beautyShopStatus: 'coming_soon' | 'live' | 'disabled',
--     quickServiceStatus: 'coming_soon' | 'pilot' | 'live' | 'disabled',
--     quickServiceRegions: string[] (ISO-2 country codes),
--     heroSlides: Array<{
--       key: 'salons' | 'independent_professionals' | 'quick_services',
--       enabled: boolean,
--       order: number,
--       eyebrow/title/description/statusText: { en, et, fr, ru } — matches
--         the _i18n jsonb pattern from 093_training_i18n.sql and the real
--         4-locale i18n system (not the "seven locales" the sprint doc
--         assumed — this repo only has en/et/fr/ru),
--       primaryAction/secondaryAction: one of a safe predefined destination
--         key (never an arbitrary URL/JS — validated server-side),
--       assetKey: string,
--       objectPosition?: string,
--     }>
--   }

CREATE TABLE IF NOT EXISTS platform_storefront_launch_config (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  draft         jsonb NOT NULL DEFAULT '{}'::jsonb,
  published     jsonb,
  version       int NOT NULL DEFAULT 0,
  published_at  timestamptz,
  published_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL
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

-- Inserts come only from the ON CONFLICT DO NOTHING seed above — no
-- user-facing INSERT policy, this table only ever has one row.
-- The public storefront-launch-config function (no auth) reads `published`
-- via service role, which already bypasses RLS — no extra policy needed.

COMMENT ON TABLE platform_storefront_launch_config IS
  'Singleton row (id=1). Admin-managed client landing-page launch/countdown config. draft is edited freely; published is only updated by an explicit publish action and is the only field the public client reads.';
