-- Backs the "Set reminder" buttons on the Tax & Reports page's upcoming-
-- deadlines list. One active reminder per (business, deadline) — setting a
-- new one replaces the old via upsert. tax-deadline-notifier (a new cron
-- function) delivers these into the existing notifications table once
-- remind_at has passed.
CREATE TABLE tax_deadline_reminders (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  deadline_key text NOT NULL CHECK (deadline_key IN ('vat_return', 'bookkeeping_close', 'annual_report')),
  remind_at    timestamptz NOT NULL,
  notified_at  timestamptz,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, deadline_key)
);

CREATE INDEX idx_tax_deadline_reminders_pending ON tax_deadline_reminders(remind_at) WHERE notified_at IS NULL;

ALTER TABLE tax_deadline_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tdr_select ON tax_deadline_reminders FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY tdr_insert ON tax_deadline_reminders FOR INSERT
  WITH CHECK (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));

CREATE POLICY tdr_update ON tax_deadline_reminders FOR UPDATE
  USING (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));

CREATE POLICY tdr_delete ON tax_deadline_reminders FOR DELETE
  USING (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));
