-- 081_bank_statements.sql
-- Bank statement import + reconciliation tables.
-- Owners import their business bank statement (CSV) and the system
-- auto-reconciles credits against payments and debits against
-- expenses, fixed_costs, and debt_payments.

CREATE TABLE bank_import_batches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  filename              text,
  row_count             int  NOT NULL DEFAULT 0,
  auto_reconciled_count int  NOT NULL DEFAULT 0,
  imported_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bank_batches_business ON bank_import_batches(business_id);

CREATE TABLE bank_transactions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 uuid NOT NULL REFERENCES businesses(id)      ON DELETE CASCADE,
  import_batch_id             uuid NOT NULL REFERENCES bank_import_batches(id) ON DELETE CASCADE,
  date                        date NOT NULL,
  description                 text NOT NULL,
  amount                      numeric(12,2) NOT NULL, -- positive = credit, negative = debit
  currency_code               text NOT NULL DEFAULT 'EUR',
  reference                   text,
  category                    text,
  notes                       text,
  reconciled_payment_id       uuid REFERENCES payments(id)       ON DELETE SET NULL,
  reconciled_expense_id       uuid REFERENCES expenses(id)       ON DELETE SET NULL,
  reconciled_fixed_cost_id    uuid REFERENCES fixed_costs(id)    ON DELETE SET NULL,
  reconciled_debt_payment_id  uuid REFERENCES debt_payments(id)  ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_bank_tx_business ON bank_transactions(business_id);
CREATE INDEX idx_bank_tx_batch    ON bank_transactions(import_batch_id);
CREATE INDEX idx_bank_tx_date     ON bank_transactions(business_id, date);

ALTER TABLE bank_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions   ENABLE ROW LEVEL SECURITY;

CREATE POLICY bank_batches_owner ON bank_import_batches
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.business_id = bank_import_batches.business_id
        AND bm.user_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
        AND bm.is_active = true
    )
  );

CREATE POLICY bank_transactions_owner ON bank_transactions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.business_id = bank_transactions.business_id
        AND bm.user_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
        AND bm.is_active = true
    )
  );
