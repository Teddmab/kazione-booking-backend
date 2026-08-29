-- 132_platform_partners.sql
--
-- Platform-level partner logos shown on the client landing page's partner
-- strip. Admin-managed (add/edit/enable/disable/reorder/remove) — this is
-- one of only two things product decided should be admin-editable on the
-- landing page, the other being the launch countdown (131).

CREATE TABLE IF NOT EXISTS platform_partners (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  logo_url      text NOT NULL,
  website_url   text,
  is_enabled    boolean NOT NULL DEFAULT true,
  display_order int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_partners_enabled_order
  ON platform_partners (display_order)
  WHERE is_enabled = true;

ALTER TABLE platform_partners ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_platform_partners"
  ON platform_partners FOR SELECT
  USING (is_platform_admin());

CREATE POLICY "admin_write_platform_partners"
  ON platform_partners FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- The public platform-partners function (no auth) reads enabled rows via
-- service role, which already bypasses RLS — no extra policy needed.

COMMENT ON TABLE platform_partners IS
  'Admin-managed partner logos for the client landing page partner strip. Hidden entirely on the client when no enabled rows exist.';
