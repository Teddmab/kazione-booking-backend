-- Enable Realtime for staff service offers so the staff mobile app can
-- invalidate "À traiter" / pending assignments without a manual refresh.
-- Idempotent: skip if already in the publication.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'staff_services'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.staff_services;
  END IF;
END $$;
