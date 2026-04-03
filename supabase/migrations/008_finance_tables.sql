-- ─────────────────────────────────────────────────────────────────────────────
-- 008_finance_tables.sql  –  suppliers, expenses, supplier_orders,
--                            supplier_order_items
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Suppliers ────────────────────────────────────────────────────────────────
-- Vendor / product supplier directory for a business. Referenced by expenses
-- and supplier_orders.
CREATE TABLE suppliers (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            text NOT NULL,
  contact_name    text,
  email           text,
  phone           text,
  website         text,
  address         text,
  notes           text,
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_suppliers_business ON suppliers(business_id);

CREATE TRIGGER trg_suppliers_updated_at
  BEFORE UPDATE ON suppliers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── Expenses ─────────────────────────────────────────────────────────────────
-- Individual expense line items (one-off or recurring). Recurring expenses
-- store their rule in recurrence_rule as JSONB; a cron function materialises
-- future occurrences up to recurrence_end_date.
CREATE TABLE expenses (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id         uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  category            expense_category NOT NULL DEFAULT 'other',
  description         text NOT NULL,
  amount              numeric(10,2) NOT NULL,
  currency_code       text NOT NULL DEFAULT 'EUR',
  tax_amount          numeric(10,2) NOT NULL DEFAULT 0,
  tax_rate            numeric(5,2) NOT NULL DEFAULT 0,
  receipt_url         text,
  date                date NOT NULL,
  is_recurring        boolean NOT NULL DEFAULT false,
  recurrence_rule     jsonb,              -- { "frequency": "monthly", "day": 1 }
  recurrence_end_date date,
  notes               text,
  created_by          uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_expenses_business_date     ON expenses(business_id, date);
CREATE INDEX idx_expenses_business_category ON expenses(business_id, category);
CREATE INDEX idx_expenses_business_supplier ON expenses(business_id, supplier_id);

CREATE TRIGGER trg_expenses_updated_at
  BEFORE UPDATE ON expenses
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── Supplier Orders ───────────────────────────────────────────────────────────
-- Purchase orders placed with suppliers. total_amount is the sum of all child
-- supplier_order_items; consider a trigger or app-level recalculation.
CREATE TABLE supplier_orders (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id     uuid NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  reference       text,
  status          supplier_order_status NOT NULL DEFAULT 'draft',
  total_amount    numeric(10,2) NOT NULL DEFAULT 0,
  notes           text,
  ordered_at      timestamptz,
  expected_at     timestamptz,
  received_at     timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_supplier_orders_business  ON supplier_orders(business_id);
CREATE INDEX idx_supplier_orders_supplier  ON supplier_orders(supplier_id);

CREATE TRIGGER trg_supplier_orders_updated_at
  BEFORE UPDATE ON supplier_orders
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── Supplier Order Items ──────────────────────────────────────────────────────
-- Line items within a supplier order. The CHECK constraint ensures
-- total_price always equals quantity * unit_price.
CREATE TABLE supplier_order_items (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id        uuid NOT NULL REFERENCES supplier_orders(id) ON DELETE CASCADE,
  product_name    text NOT NULL,
  sku             text,
  quantity        int NOT NULL DEFAULT 1,
  unit_price      numeric(10,2) NOT NULL,
  total_price     numeric(10,2) NOT NULL,
  CONSTRAINT chk_order_item_total CHECK (total_price = quantity * unit_price)
);

CREATE INDEX idx_order_items_order ON supplier_order_items(order_id);
