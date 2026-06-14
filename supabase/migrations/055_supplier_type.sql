-- ─────────────────────────────────────────────────────────────────────────────
-- 055_supplier_type.sql  –  supplier_type column on suppliers
--
-- Extends suppliers to categorise the kind of vendor/partner:
--   product   – physical goods & materials (default, existing behaviour)
--   rent      – salon rent / lease
--   utility   – electricity, water, internet, phone
--   service   – cleaning, maintenance, professional services
--   other     – catch-all
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS supplier_type text NOT NULL DEFAULT 'product'
    CONSTRAINT suppliers_type_check
      CHECK (supplier_type IN ('product', 'rent', 'utility', 'service', 'other'));

COMMENT ON COLUMN suppliers.supplier_type IS
  'Category of vendor: product | rent | utility | service | other';
