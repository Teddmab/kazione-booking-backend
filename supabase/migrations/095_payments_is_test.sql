-- 095_payments_is_test.sql
-- Adds is_test flag to payments so owners can mark a transaction as a test
-- record when deleting a completed appointment.

ALTER TABLE payments ADD COLUMN is_test boolean NOT NULL DEFAULT false;

-- Sparse index — only indexes the minority of rows where is_test is true,
-- so revenue queries can cheaply exclude them without a full-table scan.
CREATE INDEX idx_payments_is_test ON payments(business_id) WHERE is_test = true;

COMMENT ON COLUMN payments.is_test IS
  'When true, this payment is excluded from revenue reports. Set by owners when deleting a completed appointment that was a test booking.';
