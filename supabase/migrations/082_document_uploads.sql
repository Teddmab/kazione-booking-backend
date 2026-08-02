-- Migration 082: document upload fields for proof-of-payment and receipts
--
-- Adds payment_proof_url to fixed_costs so that when an owner records a
-- payment they can optionally attach a photo of the receipt/bank slip.

ALTER TABLE fixed_costs
  ADD COLUMN IF NOT EXISTS payment_proof_url TEXT;

COMMENT ON COLUMN fixed_costs.payment_proof_url IS
  'Base-64 data-URI of the payment receipt / proof attached when recording a payment.';
