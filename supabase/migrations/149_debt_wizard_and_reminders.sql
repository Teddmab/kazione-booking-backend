-- 149_debt_wizard_and_reminders.sql
-- Supports the redesigned Add/Edit debt wizard, Record Payment dialog, and
-- Set Repayment Schedule dialog:
--   - a debt "name" distinct from the free-text creditor_name
--   - creditor_type + an optional supplier_id link to the real suppliers list
--   - preferred_payment_method (prefills Record Payment)
--   - reminder_days_before + last_reminder_sent_for (owner payment reminders,
--     sent by a new task in send-reminders)
--   - a per-payment fee, now subtracted from current_balance alongside the
--     payment amount (previously only amount was subtracted)

ALTER TABLE business_debts
  ADD COLUMN IF NOT EXISTS name                     text,
  ADD COLUMN IF NOT EXISTS creditor_type             text NOT NULL DEFAULT 'business'
                             CHECK (creditor_type IN ('supplier', 'business', 'person')),
  ADD COLUMN IF NOT EXISTS supplier_id               uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS preferred_payment_method  text,
  ADD COLUMN IF NOT EXISTS reminder_days_before      int,
  ADD COLUMN IF NOT EXISTS last_reminder_sent_for    date;

CREATE INDEX IF NOT EXISTS idx_debts_supplier ON business_debts(supplier_id) WHERE supplier_id IS NOT NULL;

ALTER TABLE debt_payments
  ADD COLUMN IF NOT EXISTS fee numeric(10,2) NOT NULL DEFAULT 0;

-- Re-apply the payment trigger so it also subtracts the fee. CREATE OR
-- REPLACE keeps this safe to run alongside the original definition in
-- migration 071.
CREATE OR REPLACE FUNCTION apply_debt_payment()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE business_debts
  SET
    current_balance = GREATEST(0, current_balance - NEW.amount - COALESCE(NEW.fee, 0)),
    status = CASE
      WHEN GREATEST(0, current_balance - NEW.amount - COALESCE(NEW.fee, 0)) = 0 THEN 'paid_off'
      ELSE status
    END,
    updated_at = now()
  WHERE id = NEW.debt_id;
  RETURN NEW;
END;
$$;
