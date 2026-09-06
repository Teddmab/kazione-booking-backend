-- 152_documents_inbox.sql
-- Extends the receipts table/bucket to double as a generic "documents
-- inbox": PDFs, and rows that are just filed documents rather than an
-- OCR-scanned receipt with matching candidates.

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS document_type     text NOT NULL DEFAULT 'receipt'
    CHECK (document_type IN ('receipt', 'document')),
  ADD COLUMN IF NOT EXISTS original_filename text,
  ADD COLUMN IF NOT EXISTS mime_type         text,
  ADD COLUMN IF NOT EXISTS file_size_bytes   integer;

CREATE INDEX IF NOT EXISTS idx_receipts_business ON receipts(business_id);
CREATE INDEX IF NOT EXISTS idx_receipts_document_type ON receipts(business_id, document_type);

-- matched_to had no CHECK constraint before (app-code enforced only, in
-- receipt-scan/index.ts). Now that receipt-scan gets a second write path
-- (the new ?action=link handler) that also sets this column, pin the
-- valid set at the DB level too.
ALTER TABLE receipts
  ADD CONSTRAINT receipts_matched_to_check
  CHECK (matched_to IS NULL OR matched_to IN ('appointment', 'expense', 'bank_transaction', 'unknown'));

-- Widen the bucket to accept PDFs (scanned invoices, tax certificates,
-- contracts) and raise the cap slightly for multi-page scans.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'],
    file_size_limit     = 10485760
WHERE id = 'receipts';
