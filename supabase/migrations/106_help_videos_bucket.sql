-- Public storage bucket for contextual help videos (uploaded by platform admins)
-- Videos are public-readable so owner/staff portals can play them without auth.
-- Only platform admins may upload or delete.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'help-videos',
  'help-videos',
  true,
  209715200, -- 200 MB
  ARRAY['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']
)
ON CONFLICT DO NOTHING;

CREATE POLICY "help_videos_admin_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'help-videos'
    AND auth.uid() IS NOT NULL
    AND (SELECT is_platform_admin FROM users WHERE id = auth.uid())
  );

CREATE POLICY "help_videos_admin_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'help-videos'
    AND auth.uid() IS NOT NULL
    AND (SELECT is_platform_admin FROM users WHERE id = auth.uid())
  );

-- Public read is handled by the bucket being public; no RLS SELECT policy needed.
