-- 150_bank_reconciliation_fixes.sql
-- Fixes two bank-reconciliation gaps:
--
-- 1. Product purchases reconciled from Bookkeeping went through a separate,
--    simpler pipeline (a generic `expenses` row + a manual_in stock
--    adjustment) than the real purchase pipeline used by the Inventory tab
--    (a `stock_movements` row of type 'purchase', with VAT). This adds a
--    reconciled_stock_movement_id column so a bank transaction can link
--    directly to a real purchase stock_movement instead.
--
-- 2. Nothing prevented the same real-world debt payment from being recorded
--    twice (once from /owner/expenses, once from Bookkeeping, or from two
--    near-duplicate imported transactions) — each creates its own
--    debt_payments row and both reduce current_balance. This migration adds
--    no DB constraint (recurring debts legitimately have repeated same-amount
--    payments spaced weeks apart) — duplicate detection is applied at the
--    application layer in the debts edge function instead.

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS reconciled_stock_movement_id uuid REFERENCES stock_movements(id) ON DELETE SET NULL;
