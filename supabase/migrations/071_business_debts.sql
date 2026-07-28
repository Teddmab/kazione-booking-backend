-- 071_business_debts.sql
-- Debt register + payment log for owner financial management

-- ── business_debts ───────────────────────────────────────────────────────────

CREATE TABLE business_debts (
  id                     uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  creditor_name          text NOT NULL,
  category               text NOT NULL CHECK (category IN (
                           'tax', 'rent', 'utilities', 'bank_loan',
                           'supplier', 'equipment', 'other'
                         )),
  description            text,
  original_amount        numeric(12,2) NOT NULL CHECK (original_amount > 0),
  current_balance        numeric(12,2) NOT NULL CHECK (current_balance >= 0),
  currency_code          text NOT NULL DEFAULT 'EUR',
  interest_rate          numeric(5,2),      -- annual %, null means 0 / unknown
  monthly_minimum        numeric(10,2),     -- minimum monthly payment if known
  due_date               date,              -- final due date or next payment deadline
  start_date             date NOT NULL DEFAULT CURRENT_DATE,
  status                 text NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'paid_off', 'disputed', 'restructured')),
  priority               text NOT NULL DEFAULT 'medium'
                           CHECK (priority IN ('critical', 'high', 'medium', 'low')),
  creditor_contact       text,              -- phone / email for the creditor
  notes                  text,
  is_interest_deductible boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_debts_business ON business_debts(business_id);
CREATE INDEX idx_debts_status   ON business_debts(business_id, status);
CREATE INDEX idx_debts_priority ON business_debts(business_id, priority);

ALTER TABLE business_debts ENABLE ROW LEVEL SECURITY;

CREATE POLICY debts_owner_all ON business_debts
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.business_id = business_debts.business_id
        AND bm.user_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
        AND bm.is_active = true
    )
  );

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_business_debts_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_business_debts_updated_at
  BEFORE UPDATE ON business_debts
  FOR EACH ROW EXECUTE FUNCTION set_business_debts_updated_at();

-- ── debt_payments ─────────────────────────────────────────────────────────────

CREATE TABLE debt_payments (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  debt_id      uuid NOT NULL REFERENCES business_debts(id) ON DELETE CASCADE,
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  amount       numeric(10,2) NOT NULL CHECK (amount > 0),
  payment_date date NOT NULL DEFAULT CURRENT_DATE,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_debt_payments_debt     ON debt_payments(debt_id);
CREATE INDEX idx_debt_payments_business ON debt_payments(business_id);

ALTER TABLE debt_payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY debt_payments_owner_all ON debt_payments
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.business_id = debt_payments.business_id
        AND bm.user_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
        AND bm.is_active = true
    )
  );

-- Trigger: after a payment is recorded, reduce current_balance on the parent debt.
-- If balance reaches 0, auto-set status = 'paid_off'.
CREATE OR REPLACE FUNCTION apply_debt_payment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE business_debts
  SET
    current_balance = GREATEST(0, current_balance - NEW.amount),
    status = CASE
      WHEN GREATEST(0, current_balance - NEW.amount) = 0 THEN 'paid_off'
      ELSE status
    END,
    updated_at = now()
  WHERE id = NEW.debt_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_apply_debt_payment
  AFTER INSERT ON debt_payments
  FOR EACH ROW EXECUTE FUNCTION apply_debt_payment();
