-- ─────────────────────────────────────────────────────────────────────────────
-- 094 — add payment_method to offer_redemptions
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE offer_redemptions
  ADD COLUMN IF NOT EXISTS payment_method TEXT
    CHECK (payment_method IS NULL OR payment_method IN ('cash', 'card', 'transfer', 'mobile_money'));
