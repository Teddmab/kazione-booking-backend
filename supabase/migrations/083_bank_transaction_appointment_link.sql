-- migration 083: link bank transactions directly to appointments (credit reconciliation)
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS reconciled_appointment_id UUID
    REFERENCES appointments(id) ON DELETE SET NULL;
