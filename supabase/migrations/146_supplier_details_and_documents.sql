-- 146_supplier_details_and_documents.sql
-- Extends suppliers with registration/billing metadata, adds payment
-- tracking to supplier_orders, and a new supplier_documents feature
-- (file attachments + free-text notes) for the Supplier detail page redesign.

-- ── Supplier registration/billing metadata ─────────────────────────────────
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS company_name       text,
  ADD COLUMN IF NOT EXISTS registration_id    text,
  ADD COLUMN IF NOT EXISTS vat_number         text,
  ADD COLUMN IF NOT EXISTS country            text,
  ADD COLUMN IF NOT EXISTS preferred_currency text NOT NULL DEFAULT 'EUR';

-- ── Order payment tracking (separate from draft/ordered/received status) ──
ALTER TABLE supplier_orders
  ADD COLUMN IF NOT EXISTS paid_at  timestamptz,
  ADD COLUMN IF NOT EXISTS due_date date;

-- ── Supplier documents & notes ──────────────────────────────────────────────
CREATE TABLE supplier_documents (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  supplier_id  uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('document', 'note')),
  -- Note text for kind='note'; original filename for kind='document'.
  body         text,
  -- Storage object path, file size (bytes) and MIME type — only set for kind='document'.
  file_path    text,
  file_size    int,
  mime_type    text,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_supplier_documents_supplier ON supplier_documents(supplier_id);

ALTER TABLE supplier_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY supdoc_select ON supplier_documents FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY supdoc_insert ON supplier_documents FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY supdoc_delete ON supplier_documents FOR DELETE
  USING (business_id IN (SELECT get_my_business_ids()));

-- Private storage bucket for supplier document attachments (10 MB cap,
-- images + PDF — unlike the `receipts` bucket, owners attach invoices,
-- contracts, and agreements here, not just photos).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'supplier-documents', 'supplier-documents', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
ON CONFLICT DO NOTHING;

CREATE POLICY "supplier_documents_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'supplier-documents'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );

CREATE POLICY "supplier_documents_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'supplier-documents'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );

CREATE POLICY "supplier_documents_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'supplier-documents'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );
