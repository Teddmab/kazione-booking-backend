-- ─────────────────────────────────────────────────────────────────────────────
-- 053_service_product_usage.sql  –  service_product_usage, alter supplier_order_items
--
-- Maps services to the products they consume per booking. When an appointment
-- status transitions to 'completed', the backend deducts quantity_per_service
-- units from product_catalog.current_stock for each row here.
--
-- Also adds an optional product_id foreign key to supplier_order_items so that
-- purchase line items can be linked back to the product catalog.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE service_product_usage (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_id           uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  product_id           uuid NOT NULL REFERENCES product_catalog(id) ON DELETE CASCADE,
  quantity_per_service numeric(10,3) NOT NULL DEFAULT 1,
  UNIQUE (service_id, product_id)
);

CREATE INDEX idx_service_product_usage_service ON service_product_usage(service_id);
CREATE INDEX idx_service_product_usage_product ON service_product_usage(product_id);

-- Link purchase order line items to the product catalog (nullable — set by the UI
-- when a known product is selected, omitted for ad-hoc items).
ALTER TABLE supplier_order_items
  ADD COLUMN product_id uuid REFERENCES product_catalog(id) ON DELETE SET NULL;
