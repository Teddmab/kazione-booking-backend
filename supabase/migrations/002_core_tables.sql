-- ─────────────────────────────────────────────────────────────────────────────
-- 002_core_tables.sql  –  businesses, users mirror, business_members, business_settings
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Businesses ───────────────────────────────────────────────────────────────
CREATE TABLE businesses (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  industry        text NOT NULL DEFAULT 'salon',
  logo_url        text,
  timezone        text NOT NULL DEFAULT 'Europe/Tallinn',
  locale          text NOT NULL DEFAULT 'en',
  currency_code   text NOT NULL DEFAULT 'EUR',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Users (mirrors auth.users for profile data) ──────────────────────────────
CREATE TABLE users (
  id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email           text NOT NULL UNIQUE,
  first_name      text,
  last_name       text,
  avatar_url      text,
  phone           text,
  locale          text DEFAULT 'en',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Business Members (staff/owner/manager roles) ─────────────────────────────
CREATE TABLE business_members (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            business_role NOT NULL DEFAULT 'staff',
  is_active       boolean NOT NULL DEFAULT true,
  invited_at      timestamptz,
  joined_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id)
);

CREATE INDEX idx_business_members_business ON business_members(business_id);
CREATE INDEX idx_business_members_user    ON business_members(user_id);

-- ── Business Settings ────────────────────────────────────────────────────────
CREATE TABLE business_settings (
  id                          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id                 uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  -- Booking rules
  slot_duration_minutes       int NOT NULL DEFAULT 30,
  booking_lead_time_hours     int NOT NULL DEFAULT 2,
  booking_future_days         int NOT NULL DEFAULT 60,
  max_advance_bookings        int NOT NULL DEFAULT 3,        -- per client
  -- Cancellation / rescheduling
  cancellation_hours          int NOT NULL DEFAULT 24,
  reschedule_hours            int NOT NULL DEFAULT 24,
  -- Deposit / payment
  deposit_percentage          numeric(5,2) DEFAULT 0,        -- 0 = no deposit
  payment_required_online     boolean NOT NULL DEFAULT false,
  accept_cash                 boolean NOT NULL DEFAULT true,
  -- Tax
  tax_enabled                 boolean NOT NULL DEFAULT false,
  tax_rate                    numeric(5,2) DEFAULT 0,
  tax_label                   text DEFAULT 'VAT',
  tax_number                  text,
  -- Notifications
  reminder_email_enabled      boolean NOT NULL DEFAULT true,
  reminder_hours_before       int NOT NULL DEFAULT 24,
  review_request_enabled      boolean NOT NULL DEFAULT true,
  review_request_hours_after  int NOT NULL DEFAULT 2,
  -- Stripe
  stripe_account_id           text,
  -- Misc
  working_days                int[] DEFAULT '{1,2,3,4,5}',   -- 0=Sun…6=Sat
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Helper function: return all business_ids the calling user belongs to
CREATE OR REPLACE FUNCTION get_my_business_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT business_id
  FROM   business_members
  WHERE  user_id = auth.uid()
    AND  is_active = true;
$$;
