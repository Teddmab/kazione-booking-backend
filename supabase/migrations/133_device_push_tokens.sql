-- ---------------------------------------------------------------------------
-- 131_device_push_tokens.sql — Expo push tokens for mobile remote notifications
-- ---------------------------------------------------------------------------
-- Tokens are written only via Edge Functions (service role). No client RLS
-- policies: authenticated users never query this table directly.

CREATE TABLE IF NOT EXISTS device_push_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expo_push_token text NOT NULL,
  platform        text NOT NULL CHECK (platform IN ('ios', 'android')),
  app_variant     text NOT NULL DEFAULT 'staff',
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, expo_push_token)
);

CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user
  ON device_push_tokens(user_id);

ALTER TABLE device_push_tokens ENABLE ROW LEVEL SECURITY;
