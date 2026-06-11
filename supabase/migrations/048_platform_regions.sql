-- 048_platform_regions.sql
--
-- Tracks which countries KaziOne is officially launched in.
-- When is_enabled = false, the country is "under construction" — the marketplace
-- browse page shows a "coming soon" state for that region instead of listings.
-- Toggled by platform admins via the admin panel.

CREATE TABLE IF NOT EXISTS platform_regions (
  country_code   TEXT PRIMARY KEY,
  country_name   TEXT NOT NULL,
  is_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  enabled_at     TIMESTAMPTZ,
  enabled_by_id  UUID REFERENCES public.users(id) ON DELETE SET NULL,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE platform_regions IS
  'KaziOne market enablement — controls which countries are live vs coming soon.';

ALTER TABLE platform_regions ENABLE ROW LEVEL SECURITY;

-- Platform admins can read and update; service role (edge functions) bypasses RLS.
DROP POLICY IF EXISTS "admin_read_platform_regions" ON platform_regions;
CREATE POLICY "admin_read_platform_regions"
  ON platform_regions FOR SELECT
  USING (is_platform_admin());

DROP POLICY IF EXISTS "admin_update_platform_regions" ON platform_regions;
CREATE POLICY "admin_update_platform_regions"
  ON platform_regions FOR UPDATE
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- The marketplace-storefronts function (public, no auth) needs to read this table
-- via service role — that already bypasses RLS, so no extra policy needed.

-- ── Pre-populate all known KaziOne target markets ─────────────────────────
INSERT INTO platform_regions (country_code, country_name) VALUES
  ('EE', 'Estonia'),
  ('FI', 'Finland'),
  ('FR', 'France'),
  ('BE', 'Belgium'),
  ('DE', 'Germany'),
  ('NL', 'Netherlands'),
  ('GB', 'United Kingdom'),
  ('SE', 'Sweden'),
  ('NG', 'Nigeria'),
  ('GH', 'Ghana'),
  ('KE', 'Kenya'),
  ('UG', 'Uganda'),
  ('ZA', 'South Africa'),
  ('CD', 'Congo DRC'),
  ('CG', 'Congo'),
  ('CM', 'Cameroon'),
  ('CI', 'Côte d''Ivoire'),
  ('RW', 'Rwanda'),
  ('SN', 'Senegal'),
  ('TZ', 'Tanzania'),
  ('ZM', 'Zambia'),
  ('US', 'United States')
ON CONFLICT (country_code) DO NOTHING;
