-- 130_review_resend.sql
--
-- SPRINT_S51: on-demand "Resend review request" from the completed-
-- appointment Overview. Kept separate from the automatic on-completion send
-- (appointments/index.ts, status → completed) — last_manual_resend_at is
-- only ever written by the new resend-review-request action, so an owner
-- resending manually never affects, and is never affected by, the automatic
-- send. Rate-limited to once per hour so a mashed button can't spam a client.

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS last_manual_resend_at timestamptz;

COMMENT ON COLUMN reviews.last_manual_resend_at IS
  'Set by appointments/index.ts?action=resend-review-request each time an owner/manager manually resends the review-request email. Independent of the automatic on-completion send. Used to rate-limit manual resends to once per hour.';
