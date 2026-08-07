-- ─────────────────────────────────────────────────────────────────────────────
-- 088 — Training e-learning (S33)
-- Tables: training_courses, training_chapters, training_sections, training_progress
-- Storage: private bucket "training-videos"
-- ─────────────────────────────────────────────────────────────────────────────

-- One course per business_offer of type "training"
CREATE TABLE training_courses (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  offer_id    UUID        NOT NULL REFERENCES business_offers(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(offer_id)
);

-- Ordered groups of sections within a course
CREATE TABLE training_chapters (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  UUID        NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
  title      TEXT        NOT NULL,
  position   INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Individual content units: video, text, or quiz
CREATE TABLE training_sections (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id   UUID        NOT NULL REFERENCES training_chapters(id) ON DELETE CASCADE,
  title        TEXT        NOT NULL,
  content_type TEXT        NOT NULL CHECK (content_type IN ('video', 'text', 'quiz')),
  content_text TEXT,       -- text: body; quiz: JSON {question, options[], correct}
  video_url    TEXT,       -- private bucket storage path
  position     INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-redemption section completion (one row per section completed)
CREATE TABLE training_progress (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  redemption_id UUID        NOT NULL REFERENCES offer_redemptions(id) ON DELETE CASCADE,
  section_id    UUID        NOT NULL REFERENCES training_sections(id) ON DELETE CASCADE,
  completed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(redemption_id, section_id)
);

-- Indexes
CREATE INDEX idx_training_courses_business    ON training_courses(business_id);
CREATE INDEX idx_training_courses_offer       ON training_courses(offer_id);
CREATE INDEX idx_training_chapters_course     ON training_chapters(course_id, position);
CREATE INDEX idx_training_sections_chapter    ON training_sections(chapter_id, position);
CREATE INDEX idx_training_progress_redemption ON training_progress(redemption_id);
CREATE INDEX idx_training_progress_section    ON training_progress(section_id);

-- updated_at trigger for courses
CREATE TRIGGER trg_training_courses_updated_at
  BEFORE UPDATE ON training_courses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: edge functions run as service_role (bypasses RLS)
ALTER TABLE training_courses  ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_progress ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_training_courses"
  ON training_courses FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_training_chapters"
  ON training_chapters FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_training_sections"
  ON training_sections FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_training_progress"
  ON training_progress FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Private storage bucket for training videos (500 MB per file)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'training-videos',
  'training-videos',
  false,
  524288000,
  ARRAY['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']
)
ON CONFLICT (id) DO NOTHING;
