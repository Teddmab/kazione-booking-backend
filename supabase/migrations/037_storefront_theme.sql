-- Add theme column to storefronts for per-tenant visual customisation.
-- Theme controls accent color, hero overlay, and card styling on the public storefront.
ALTER TABLE storefronts
  ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'default';
