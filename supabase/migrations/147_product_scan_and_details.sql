-- 147_product_scan_and_details.sql
-- Extends product_catalog with the fields shown in the redesigned "Add
-- product" flow (brand, barcode, colour, size, description, storage
-- location, brand logo, draft state), adds VAT/receipt/purchase-date
-- tracking to stock_movements for the bundled "record first purchase"
-- step, and a new product_scan_photos feature (storage + table) so the
-- photos used for AI extraction are kept, not discarded after scanning.

-- ── Product details ─────────────────────────────────────────────────────────
ALTER TABLE product_catalog
  ADD COLUMN IF NOT EXISTS brand            text,
  ADD COLUMN IF NOT EXISTS barcode          text,
  ADD COLUMN IF NOT EXISTS colour           text,
  ADD COLUMN IF NOT EXISTS size_label       text,
  ADD COLUMN IF NOT EXISTS description      text,
  ADD COLUMN IF NOT EXISTS storage_location text,
  ADD COLUMN IF NOT EXISTS brand_logo_url   text,
  ADD COLUMN IF NOT EXISTS is_draft         boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_product_catalog_barcode ON product_catalog(business_id, barcode) WHERE barcode IS NOT NULL;

-- ── Purchase recording: VAT + receipt + an editable transaction date ───────
-- (distinct from created_at, matching cost_date/ordered_at elsewhere)
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS vat_rate      numeric(5,2),
  ADD COLUMN IF NOT EXISTS receipt_url   text,
  ADD COLUMN IF NOT EXISTS movement_date date NOT NULL DEFAULT CURRENT_DATE;

-- ── Product scan photos ──────────────────────────────────────────────────────
-- One row per photo used in a "Scan product" AI extraction. product_id is
-- nullable because photos are uploaded (and this audit row created) at scan
-- time, before the product itself is saved — the create-product call links
-- them by passing back their ids.
CREATE TABLE product_scan_photos (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id   uuid REFERENCES product_catalog(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('front_label', 'barcode', 'ingredients', 'other')),
  storage_path text NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_scan_photos_product ON product_scan_photos(product_id) WHERE product_id IS NOT NULL;
CREATE INDEX idx_product_scan_photos_business ON product_scan_photos(business_id);

ALTER TABLE product_scan_photos ENABLE ROW LEVEL SECURITY;

CREATE POLICY prodscan_select ON product_scan_photos FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY prodscan_insert ON product_scan_photos FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY prodscan_update ON product_scan_photos FOR UPDATE
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY prodscan_delete ON product_scan_photos FOR DELETE
  USING (business_id IN (SELECT get_my_business_ids()));

-- Private storage bucket for product scan photos (8 MB cap, images only —
-- mirrors the `receipts` and `supplier-documents` buckets' pattern).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-scans', 'product-scans', false, 8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT DO NOTHING;

CREATE POLICY "product_scans_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'product-scans'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );

CREATE POLICY "product_scans_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'product-scans'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );

CREATE POLICY "product_scans_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'product-scans'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );
