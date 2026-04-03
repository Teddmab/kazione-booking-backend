-- ─────────────────────────────────────────────────────────────────────────────
-- 005_client_tables.sql  –  clients
-- ─────────────────────────────────────────────────────────────────────────────

-- Per-business client records. A client with a non-null user_id is a registered
-- user who booked through the platform; a NULL user_id represents a guest or
-- manually-added client. The partial unique index on email prevents duplicate
-- client records within the same business while still allowing multiple guests
-- with no email.
CREATE TABLE clients (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id               uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = guest
  first_name            text NOT NULL,
  last_name             text NOT NULL,
  email                 text,
  phone                 text,
  avatar_url            text,
  date_of_birth         date,
  notes                 text,
  tags                  text[] NOT NULL DEFAULT '{}',
  preferred_staff_id    uuid REFERENCES staff_profiles(id) ON DELETE SET NULL,
  preferred_locale      text NOT NULL DEFAULT 'en',
  gdpr_consent          boolean NOT NULL DEFAULT false,
  gdpr_consent_at       timestamptz,
  marketing_opt_in      boolean NOT NULL DEFAULT false,
  source                text NOT NULL DEFAULT 'manual',  -- manual, import, marketplace, walk_in
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Partial unique: one email per business (guests without email are exempt)
CREATE UNIQUE INDEX idx_clients_email_unique
  ON clients(business_id, email)
  WHERE email IS NOT NULL;

CREATE INDEX idx_clients_user       ON clients(business_id, user_id);
CREATE INDEX idx_clients_email      ON clients(business_id, email);
CREATE INDEX idx_clients_created    ON clients(business_id, created_at);
CREATE INDEX idx_clients_source     ON clients(business_id, source);

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
