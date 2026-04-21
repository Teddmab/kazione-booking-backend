-- Migration 021: Add stripe_accounts table for Stripe Connect management
CREATE TABLE IF NOT EXISTS stripe_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL UNIQUE,
  -- Stripe account ID (acct_xxxx)
  connected BOOLEAN DEFAULT FALSE,
  data JSONB,
  -- Raw Stripe account object for reference
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(business_id) -- Only one Stripe account per business
);
-- Enable RLS
ALTER TABLE stripe_accounts ENABLE ROW LEVEL SECURITY;
-- RLS: Business members can see their business's Stripe account
CREATE POLICY "business_members_can_read_stripe_account" ON stripe_accounts FOR
SELECT USING (
    business_id IN (
      SELECT business_id
      FROM business_members
      WHERE user_id = auth.uid()
        AND is_active = TRUE
    )
  );
-- RLS: Owners/managers can update their business's Stripe account
CREATE POLICY "owners_managers_can_update_stripe_account" ON stripe_accounts FOR
UPDATE USING (
    business_id IN (
      SELECT bm.business_id
      FROM business_members bm
      WHERE bm.user_id = auth.uid()
        AND bm.is_active = TRUE
        AND bm.role IN ('owner', 'manager')
    )
  );
-- RLS: Owners/managers can delete their business's Stripe account
CREATE POLICY "owners_managers_can_delete_stripe_account" ON stripe_accounts FOR DELETE USING (
  business_id IN (
    SELECT bm.business_id
    FROM business_members bm
    WHERE bm.user_id = auth.uid()
      AND bm.is_active = TRUE
      AND bm.role IN ('owner', 'manager')
  )
);
-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION stripe_accounts_update_timestamp() RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW();
RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER stripe_accounts_timestamp BEFORE
UPDATE ON stripe_accounts FOR EACH ROW EXECUTE FUNCTION stripe_accounts_update_timestamp();
