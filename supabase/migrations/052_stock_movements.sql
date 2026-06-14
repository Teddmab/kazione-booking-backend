-- ─────────────────────────────────────────────────────────────────────────────
-- 052_stock_movements.sql  –  stock_movements
--
-- Append-only audit trail of all stock changes. Positive quantity = stock in
-- (purchase, manual_in). Negative quantity = stock out (service_use, manual_out,
-- wastage). current_stock on product_catalog is always the running sum.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE stock_movements (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES product_catalog(id) ON DELETE CASCADE,
  movement_type   text NOT NULL CHECK (movement_type IN (
                    'purchase', 'service_use', 'manual_in', 'manual_out', 'wastage'
                  )),
  quantity        numeric(10,3) NOT NULL,  -- positive = in, negative = out
  unit_cost       numeric(10,2),           -- cost per unit at time of movement
  reference_id    uuid,                    -- supplier_order.id or appointment.id
  reference_type  text CHECK (reference_type IN ('supplier_order', 'appointment', 'manual')),
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_stock_movements_product   ON stock_movements(product_id);
CREATE INDEX idx_stock_movements_business  ON stock_movements(business_id, created_at DESC);
CREATE INDEX idx_stock_movements_reference ON stock_movements(reference_id) WHERE reference_id IS NOT NULL;
