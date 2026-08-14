-- Migration 104: Contextual Help Creator
-- Stores short video + quiz help items keyed to specific routes/sections.

CREATE TABLE IF NOT EXISTS contextual_help (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text        NOT NULL,
  description text,
  video_url   text,
  quiz_json   jsonb,
  target_path text        NOT NULL,
  target_section  text,
  target_element  text,
  portal      text        NOT NULL DEFAULT 'owner'
                          CHECK (portal IN ('owner', 'staff', 'both')),
  is_active   boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contextual_help_path
  ON contextual_help (target_path, portal, is_active);
