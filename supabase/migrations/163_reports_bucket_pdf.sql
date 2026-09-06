-- Widens the reports storage bucket to accept PDF uploads alongside the
-- existing CSV exports, for the new Tax & Reports PDF report generation.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY['text/csv', 'application/pdf']
WHERE id = 'reports';
