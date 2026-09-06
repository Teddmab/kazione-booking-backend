-- Structured billing city/postal code, plus an optional separate delivery
-- address, for the redesigned Edit Supplier modal. The existing `address`
-- column remains the billing street line and `country` the billing country.
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS billing_city text,
  ADD COLUMN IF NOT EXISTS billing_postal_code text,
  ADD COLUMN IF NOT EXISTS delivery_same_as_billing boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS delivery_street text,
  ADD COLUMN IF NOT EXISTS delivery_city text,
  ADD COLUMN IF NOT EXISTS delivery_postal_code text,
  ADD COLUMN IF NOT EXISTS delivery_country text;
