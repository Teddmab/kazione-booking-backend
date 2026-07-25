-- ── Product photo + Invoice photo ──────────────────────────────────────────
-- Adds optional photo URL to product_catalog so owners can photograph products.
-- Adds optional invoice_photo_url to supplier_orders for receipt archiving.

ALTER TABLE product_catalog
  ADD COLUMN IF NOT EXISTS photo_url text;

ALTER TABLE supplier_orders
  ADD COLUMN IF NOT EXISTS invoice_photo_url text;
