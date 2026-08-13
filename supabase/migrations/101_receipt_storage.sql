-- Add OCR and appointment linkage to expenses
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS appointment_id uuid REFERENCES appointments(id),
  ADD COLUMN IF NOT EXISTS ocr_data       jsonb;

-- Receipts audit table (one row per scan, regardless of match outcome)
CREATE TABLE receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  owner_id     uuid NOT NULL REFERENCES auth.users(id),
  storage_path text NOT NULL,
  ocr_data     jsonb NOT NULL DEFAULT '{}',
  matched_to   text,        -- 'appointment' | 'expense' | 'unknown' | null
  matched_id   uuid,
  created_at   timestamptz DEFAULT now()
);

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "receipts_owner_access"
  ON receipts FOR ALL
  USING (business_id IN (
    SELECT business_id FROM business_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'manager')
  ));

-- Private storage bucket for receipt images (5 MB cap)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'receipts', 'receipts', false, 5242880,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT DO NOTHING;

-- Storage RLS: owners and managers of the business may upload
CREATE POLICY "receipts_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );

CREATE POLICY "receipts_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'receipts'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );

CREATE POLICY "receipts_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'receipts'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 1)
    )
  );
