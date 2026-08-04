-- ─────────────────────────────────────────────────────────────────────────────
-- 084 — client entitlements (packages, vouchers, discounts, training)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Core entitlements table ───────────────────────────────────────────────────
CREATE TABLE client_entitlements (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id       UUID        NOT NULL REFERENCES clients(id)    ON DELETE CASCADE,

  -- One of: appointment_discount | package | training | gift_voucher
  type            TEXT        NOT NULL,

  name            TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'active',
  notes           TEXT,

  -- Appointment discount fields
  discount_type   TEXT,          -- 'percentage' | 'fixed'
  discount_value  NUMERIC,
  service_ids     UUID[],        -- NULL = applies to any service

  -- Package / Training fields
  total_sessions  INTEGER,
  sessions_used   INTEGER        NOT NULL DEFAULT 0,
  curriculum_text TEXT,          -- training only

  -- Gift voucher fields
  original_value  NUMERIC,
  remaining_balance NUMERIC,

  -- Payment (upfront types)
  price_paid      NUMERIC,
  payment_method  TEXT,          -- 'cash' | 'card' | 'bank_transfer' | 'online' | 'pawapay'
  payment_reference TEXT,
  paid_at         TIMESTAMPTZ,

  -- Validity
  expires_at      DATE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT entitlements_type_check
    CHECK (type IN ('appointment_discount', 'package', 'training', 'gift_voucher')),

  CONSTRAINT entitlements_status_check
    CHECK (status IN ('active', 'used', 'expired', 'cancelled')),

  CONSTRAINT entitlements_discount_type_check
    CHECK (discount_type IS NULL OR discount_type IN ('percentage', 'fixed')),

  CONSTRAINT entitlements_sessions_check
    CHECK (sessions_used >= 0 AND (total_sessions IS NULL OR sessions_used <= total_sessions)),

  CONSTRAINT entitlements_balance_check
    CHECK (remaining_balance IS NULL OR remaining_balance >= 0)
);

-- ── Redemption log ────────────────────────────────────────────────────────────
-- Records every time an entitlement is drawn against an appointment.
CREATE TABLE entitlement_redemptions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id   UUID        NOT NULL REFERENCES client_entitlements(id) ON DELETE CASCADE,
  appointment_id   UUID        REFERENCES appointments(id) ON DELETE SET NULL,
  amount_redeemed  NUMERIC,    -- sessions used (1) or voucher amount deducted
  discount_applied NUMERIC,    -- actual price reduction on the appointment
  notes            TEXT,
  redeemed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Link appointments to the entitlement applied at checkout ──────────────────
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS entitlement_id UUID REFERENCES client_entitlements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS entitlement_discount NUMERIC; -- actual discount amount applied

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX idx_entitlements_business  ON client_entitlements(business_id);
CREATE INDEX idx_entitlements_client    ON client_entitlements(client_id);
CREATE INDEX idx_entitlements_status    ON client_entitlements(status);
CREATE INDEX idx_redemptions_entitlement ON entitlement_redemptions(entitlement_id);
CREATE INDEX idx_redemptions_appointment ON entitlement_redemptions(appointment_id);
CREATE INDEX idx_appointments_entitlement ON appointments(entitlement_id) WHERE entitlement_id IS NOT NULL;

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_entitlements_updated_at'
  ) THEN
    CREATE TRIGGER trg_entitlements_updated_at
      BEFORE UPDATE ON client_entitlements
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE client_entitlements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE entitlement_redemptions ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (edge functions use service role key)
CREATE POLICY "service_role_all_entitlements"
  ON client_entitlements FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_redemptions"
  ON entitlement_redemptions FOR ALL TO service_role USING (true) WITH CHECK (true);
