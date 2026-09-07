-- 169_tax_return_drafts.sql
-- Persists which step a user reached in a tax-obligation prep wizard (the
-- VAT prep wizard today), so closing and reopening it for the same period
-- resumes instead of restarting at step 1. Deliberately stores only the
-- step position, not a snapshot of computed figures — readiness/calculation
-- numbers are always live-recomputed from real records, so freezing old
-- numbers here would go stale and mislead. One row per business+period+
-- obligation, upserted like tax_deadline_reminders.

CREATE TABLE tax_return_drafts (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  obligation_type text NOT NULL CHECK (obligation_type IN ('vat_return', 'income_social_tax', 'annual_report')),
  period          text NOT NULL,
  step            integer NOT NULL DEFAULT 1,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, period, obligation_type)
);

CREATE INDEX idx_tax_return_drafts_business ON tax_return_drafts(business_id);

CREATE TRIGGER trg_tax_return_drafts_updated_at
  BEFORE UPDATE ON tax_return_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tax_return_drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY trd_select ON tax_return_drafts FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY trd_insert ON tax_return_drafts FOR INSERT
  WITH CHECK (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));

CREATE POLICY trd_update ON tax_return_drafts FOR UPDATE
  USING (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));

CREATE POLICY trd_delete ON tax_return_drafts FOR DELETE
  USING (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));
