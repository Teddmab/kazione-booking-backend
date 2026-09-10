-- 174_tax_activity_log.sql
-- Backs the Obligations tab's "Recent activity" feed. Append-only, written
-- by the finance edge function alongside its existing tax-profile/tax-draft/
-- tax-filings writes — there is no comment-authoring endpoint, so entries
-- only ever record real system events (draft saved, status changed,
-- submission recorded, payment recorded, profile updated). An
-- accountant-authored comment type is deliberately not included: it needs a
-- real accountant identity/collaboration feature that doesn't exist yet.

CREATE TABLE tax_activity_log (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  obligation_type text CHECK (obligation_type IN ('vat_return', 'income_social_tax', 'annual_report')),
  period          text,
  activity_type   text NOT NULL CHECK (activity_type IN ('draft_updated', 'status_changed', 'external_submission', 'profile_updated', 'payment_recorded')),
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  description     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_tax_activity_log_business ON tax_activity_log(business_id, created_at DESC);

ALTER TABLE tax_activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY tal_select ON tax_activity_log FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY tal_insert ON tax_activity_log FOR INSERT
  WITH CHECK (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));
