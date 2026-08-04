-- ─────────────────────────────────────────────────────────────────────────────
-- 085 — business offers (catalog templates + per-client redemptions)
-- Part B of S31: Offers Module + Bank Transfer Bookkeeping Link
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Offer catalog (templates the business publishes) ─────────────────────────
CREATE TABLE business_offers (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  type                TEXT        NOT NULL
    CHECK (type IN ('appointment_discount', 'package', 'training', 'gift_voucher')),

  title               TEXT        NOT NULL,
  description         TEXT,

  -- Discount fields (appointment_discount)
  discount_type       TEXT        CHECK (discount_type IN ('percentage', 'fixed_amount')),
  discount_value      NUMERIC(10,2),
  applies_to_services UUID[]      NOT NULL DEFAULT '{}', -- empty = all services

  -- Price for paid offers (package / training / gift_voucher)
  price               NUMERIC(10,2),
  currency_code       TEXT        NOT NULL DEFAULT 'EUR',

  -- Session tracking (package / training)
  sessions_total      INT,       -- NULL for discount and gift_voucher

  -- Validity & limits
  valid_from          DATE,
  valid_until         DATE,
  max_redemptions     INT,       -- NULL = unlimited
  is_active           BOOLEAN     NOT NULL DEFAULT true,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT offers_type_check
    CHECK (type IN ('appointment_discount', 'package', 'training', 'gift_voucher')),

  CONSTRAINT offers_discount_type_check
    CHECK (discount_type IS NULL OR discount_type IN ('percentage', 'fixed_amount')),

  CONSTRAINT offers_discount_value_check
    CHECK (discount_value IS NULL OR discount_value > 0),

  CONSTRAINT offers_sessions_check
    CHECK (sessions_total IS NULL OR sessions_total > 0),

  CONSTRAINT offers_price_check
    CHECK (price IS NULL OR price >= 0)
);

-- ── Per-client redemption instances ──────────────────────────────────────────
CREATE TABLE offer_redemptions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id            UUID        NOT NULL REFERENCES business_offers(id) ON DELETE CASCADE,
  business_id         UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id           UUID        REFERENCES clients(id) ON DELETE SET NULL,

  -- Session tracking (package / training)
  sessions_total      INT,
  sessions_used       INT         NOT NULL DEFAULT 0,

  -- Gift voucher balance
  voucher_value       NUMERIC(10,2),
  voucher_used        NUMERIC(10,2) NOT NULL DEFAULT 0,

  -- Payment (for paid offer types)
  payment_id          UUID        REFERENCES payments(id) ON DELETE SET NULL,
  bank_transaction_id UUID        REFERENCES bank_transactions(id) ON DELETE SET NULL,
  amount_paid         NUMERIC(10,2),

  status              TEXT        NOT NULL DEFAULT 'active'
    CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
  notes               TEXT,

  redeemed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT redemptions_sessions_check
    CHECK (sessions_used >= 0 AND (sessions_total IS NULL OR sessions_used <= sessions_total)),

  CONSTRAINT redemptions_voucher_check
    CHECK (voucher_used >= 0 AND (voucher_value IS NULL OR voucher_used <= voucher_value))
);

-- ── Link appointments to the offer redemption that funded them ────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS offer_redemption_id UUID
    REFERENCES offer_redemptions(id) ON DELETE SET NULL;

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_offers_business       ON business_offers(business_id);
CREATE INDEX idx_offers_active         ON business_offers(business_id) WHERE is_active;
CREATE INDEX idx_redemptions_offer     ON offer_redemptions(offer_id);
CREATE INDEX idx_redemptions_business  ON offer_redemptions(business_id);
CREATE INDEX idx_redemptions_client    ON offer_redemptions(client_id);
CREATE INDEX idx_redemptions_status    ON offer_redemptions(status);
CREATE INDEX idx_redemptions_bank_tx   ON offer_redemptions(bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
CREATE INDEX idx_appts_offer_redemption ON appointments(offer_redemption_id) WHERE offer_redemption_id IS NOT NULL;

-- ── updated_at trigger for business_offers ───────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_business_offers_updated_at'
  ) THEN
    CREATE TRIGGER trg_business_offers_updated_at
      BEFORE UPDATE ON business_offers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE business_offers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_redemptions   ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_offers"
  ON business_offers FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_redemptions"
  ON offer_redemptions FOR ALL TO service_role USING (true) WITH CHECK (true);
