-- 115_review_moderation.sql
--
-- S61: adds moderation (hide/unhide) support for reviews. is_public already
-- exists and is already the actual visibility gate every public read path
-- filters on (get-storefront, marketplace-storefronts, ai-insights) — this
-- migration doesn't change that contract.
--
-- moderated_at/moderated_by/moderation_reason are deliberately separate from
-- is_public: is_public = false already has an existing, different meaning
-- (a placeholder row created at booking-completion time, before the client
-- has actually submitted — see appointments/index.ts's review-token flow).
-- moderated_at IS NOT NULL is the new, unambiguous "a human actively hid or
-- restored this" signal, independent of the placeholder case.
--
-- review_moderation_log is the tenant-scoped audit trail for this action,
-- the third instance of this codebase's established one-small-table-per-
-- actor-domain pattern (admin_audit_log for platform admins, staff_action_log
-- for owner/manager actions on staff accounts — this migration's table and
-- RLS policy are modeled directly on staff_action_log, 111_staff_action_log.sql).

ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS moderated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS moderated_at     timestamptz,
  ADD COLUMN IF NOT EXISTS moderation_reason text;

CREATE TABLE IF NOT EXISTS review_moderation_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  review_id       uuid        NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  actor_user_id   uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action          text        NOT NULL,
  -- Action values:
  --   HIDDEN
  --   UNHIDDEN
  reason          text        NOT NULL,
  target_meta     jsonb,      -- snapshot of relevant context at time of action
  ip_address      inet,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_review_moderation_log_business_time
  ON review_moderation_log (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_moderation_log_review
  ON review_moderation_log (review_id);

ALTER TABLE review_moderation_log ENABLE ROW LEVEL SECURITY;

-- Owner/manager of the business can read its log.
CREATE POLICY "business_read_review_moderation_log"
  ON review_moderation_log FOR SELECT
  USING (
    business_id IN (SELECT get_my_business_ids())
    AND get_user_role(business_id) IN ('owner', 'manager')
  );

-- Inserts come exclusively from edge functions via service role (bypasses
-- RLS). No user-facing INSERT, UPDATE, or DELETE policies — append-only.

COMMENT ON TABLE review_moderation_log IS
  'Tenant-scoped audit log of review hide/unhide actions by owner/manager. Insert-only. Platform-admin moderation logs to admin_audit_log instead, not here.';
