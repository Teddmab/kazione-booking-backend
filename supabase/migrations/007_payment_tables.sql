-- ─────────────────────────────────────────────────────────────────────────────
-- 007_payment_tables.sql  –  payments
-- ─────────────────────────────────────────────────────────────────────────────

-- Records every monetary transaction tied to an appointment. Stripe fields
-- track the external payment lifecycle; refund_amount / refunded_at record
-- partial or full refunds. Multiple payments per appointment are supported
-- (e.g. deposit + remaining balance).
CREATE TABLE payments (
  id                          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id                 uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  appointment_id              uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  client_id                   uuid REFERENCES clients(id) ON DELETE SET NULL,
  amount                      numeric(10,2) NOT NULL,
  currency_code               text NOT NULL DEFAULT 'EUR',
  tip_amount                  numeric(10,2) NOT NULL DEFAULT 0,
  discount_amount             numeric(10,2) NOT NULL DEFAULT 0,
  discount_code               text,
  tax_amount                  numeric(10,2) NOT NULL DEFAULT 0,
  tax_rate                    numeric(5,2) NOT NULL DEFAULT 0,
  status                      payment_status NOT NULL DEFAULT 'pending',
  method                      payment_method NOT NULL DEFAULT 'card',
  stripe_payment_intent_id    text UNIQUE,
  stripe_charge_id            text,
  stripe_refund_id            text,
  paid_at                     timestamptz,
  refunded_at                 timestamptz,
  refund_amount               numeric(10,2) NOT NULL DEFAULT 0,
  notes                       text,
  receipt_url                 text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_payments_amount CHECK (amount > 0)
);

CREATE INDEX idx_payments_business_appt   ON payments(business_id, appointment_id);
CREATE INDEX idx_payments_business_status ON payments(business_id, status);
CREATE INDEX idx_payments_business_paid   ON payments(business_id, paid_at);

CREATE TRIGGER trg_payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
