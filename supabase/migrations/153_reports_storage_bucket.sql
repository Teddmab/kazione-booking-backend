-- 153_reports_storage_bucket.sql
-- export-report/index.ts has always uploaded generated CSVs to a `reports`
-- storage bucket (path `reports/{business_id}/{year}/{filename}.csv`), but
-- no prior migration ever created that bucket — every export_report call in
-- an environment where it wasn't created out-of-band (e.g. manually in a
-- dashboard) has been failing with "Bucket not found" for every report
-- type, not just any one of them. This creates it, mirroring the private
-- bucket + storage-RLS pattern already used for `receipts` (101_receipt_storage.sql).
--
-- Note the path's business_id is the SECOND segment (after a literal
-- "reports/" prefix), unlike `receipts` where it's the first — the RLS
-- checks split_part(name, '/', 2) accordingly.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('reports', 'reports', false, 10485760, ARRAY['text/csv'])
ON CONFLICT DO NOTHING;

CREATE POLICY "reports_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'reports'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 2)
    )
  );

CREATE POLICY "reports_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'reports'
    AND auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM business_members
      WHERE user_id   = auth.uid()
        AND role      IN ('owner', 'manager')
        AND is_active = true
        AND business_id::text = split_part(name, '/', 2)
    )
  );
