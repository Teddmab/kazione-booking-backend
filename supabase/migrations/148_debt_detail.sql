-- 148_debt_detail.sql
-- Debt detail page: a reference number + archive state on business_debts,
-- richer payment records (method/reference/receipt/recorded-by), and a new
-- debt_documents feature (file attachments + free-text notes) mirroring the
-- supplier_documents pattern from migration 146.

-- ── business_debts additions ────────────────────────────────────────────────
ALTER TABLE business_debts
  ADD COLUMN IF NOT EXISTS reference   text,
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

-- ── debt_payments additions ─────────────────────────────────────────────────
-- payment_method was already collected by the Record Payment dialog but
-- never persisted — this fixes that along with adding the new fields.
ALTER TABLE debt_payments
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS reference      text,
  ADD COLUMN IF NOT EXISTS receipt_url    text,
  ADD COLUMN IF NOT EXISTS created_by     uuid REFERENCES users(id) ON DELETE SET NULL;

-- ── Debt documents & notes ──────────────────────────────────────────────────
CREATE TABLE debt_documents (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  debt_id      uuid NOT NULL REFERENCES business_debts(id) ON DELETE CASCADE,
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

CREATE INDEX idx_debt_documents_debt ON debt_documents(debt_id);

ALTER TABLE debt_documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY debtdoc_select ON debt_documents FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY debtdoc_insert ON debt_documents FOR INSERT
  WITH CHECK (business_id IN (SELECT get_my_business_ids()));
CREATE POLICY debtdoc_delete ON debt_documents FOR DELETE
  USING (business_id IN (SELECT get_my_business_ids()));

-- Private storage bucket for debt document attachments and payment receipts
-- (10 MB cap, mirrors supplier-documents).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'debt-documents', 'debt-documents', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']
)
ON CONFLICT DO NOTHING;

CREATE POLICY "debt_documents_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'debt-documents'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );

CREATE POLICY "debt_documents_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'debt-documents'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );

CREATE POLICY "debt_documents_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'debt-documents'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );
