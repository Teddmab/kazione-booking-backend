-- Create the business-assets storage bucket used by storefront-upload.
-- Public: image URLs are served directly without signed read URLs.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'business-assets',
  'business-assets',
  true,
  5242880,  -- 5 MB per file
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO NOTHING;

-- Allow any authenticated user to upload to their own business folder.
CREATE POLICY "owners can upload business assets"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'business-assets');

-- Allow public read of all objects in the bucket.
CREATE POLICY "public can read business assets"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'business-assets');

-- Allow authenticated users to overwrite (upsert) objects — needed for logo/cover re-uploads.
CREATE POLICY "owners can update business assets"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'business-assets')
  WITH CHECK (bucket_id = 'business-assets');

-- Allow authenticated users to delete objects in their business folder.
CREATE POLICY "owners can delete business assets"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'business-assets');
