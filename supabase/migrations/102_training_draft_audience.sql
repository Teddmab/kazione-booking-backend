-- S44: Training draft mode and target audience
-- Allows course authors to work in draft before publishing,
-- and to flag courses as staff-only internal training.

ALTER TABLE business_offers
  ADD COLUMN IF NOT EXISTS publish_status text NOT NULL DEFAULT 'published'
    CHECK (publish_status IN ('draft', 'published'));

ALTER TABLE business_offers
  ADD COLUMN IF NOT EXISTS target_audience text NOT NULL DEFAULT 'client'
    CHECK (target_audience IN ('client', 'staff', 'both'));

CREATE INDEX IF NOT EXISTS idx_offers_audience
  ON business_offers (business_id, target_audience, publish_status);
