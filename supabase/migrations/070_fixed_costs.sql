-- ── Fixed Costs ──────────────────────────────────────────────────────────────
-- Recurring and one-off operating expenses that are NOT product purchases:
-- rent, utilities, insurance, maintenance, etc. These feed into the Spending
-- Overview alongside supplier purchase orders.

CREATE TABLE fixed_costs (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name            text NOT NULL,
  category        text NOT NULL CHECK (category IN ('rent', 'electricity', 'water', 'internet_phone', 'insurance', 'maintenance', 'other')),
  amount          numeric(10,2) NOT NULL CHECK (amount >= 0),
  currency_code   text NOT NULL DEFAULT 'EUR',
  frequency       text NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'annual', 'one_off')),
  cost_date       date NOT NULL,
  is_tax_deductible boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_fixed_costs_business ON fixed_costs(business_id);
CREATE INDEX idx_fixed_costs_date     ON fixed_costs(business_id, cost_date);

CREATE TRIGGER trg_fixed_costs_updated_at
  BEFORE UPDATE ON fixed_costs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- RLS — same pattern as other business-scoped tables
ALTER TABLE fixed_costs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fixed_costs_business_members" ON fixed_costs
  USING (
    EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.business_id = fixed_costs.business_id
        AND bm.user_id = auth.uid()
        AND bm.is_active = true
    )
  );
