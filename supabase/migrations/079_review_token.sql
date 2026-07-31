-- Migration 079: Add review token columns to support S16 token-based review flow
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS review_token TEXT UNIQUE;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS token_used_at TIMESTAMPTZ;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS reviewer_name TEXT;

CREATE INDEX IF NOT EXISTS reviews_review_token_idx
  ON reviews(review_token)
  WHERE review_token IS NOT NULL;
