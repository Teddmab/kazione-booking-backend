-- ─────────────────────────────────────────────────────────────────────────────
-- 051_product_catalog.sql  –  product_catalog
--
-- Business product directory used for stock tracking. Products are linked to
-- suppliers (optional) and referenced by stock_movements and service_product_usage.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE product_catalog (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id     uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  name            text NOT NULL,
  sku             text,
  category        text,
  unit            text NOT NULL DEFAULT 'piece',  -- ml, g, piece, bottle, etc.
  unit_cost       numeric(10,2),
  current_stock   numeric(10,3) NOT NULL DEFAULT 0,
  min_stock_alert numeric(10,3),                  -- alert when stock drops below this
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_catalog_business  ON product_catalog(business_id);
CREATE INDEX idx_product_catalog_supplier  ON product_catalog(supplier_id);
CREATE INDEX idx_product_catalog_active    ON product_catalog(business_id, is_active);

CREATE TRIGGER trg_product_catalog_updated_at
  BEFORE UPDATE ON product_catalog
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
