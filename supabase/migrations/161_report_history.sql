-- Logs every report generated via export-report (CSV or PDF) — the "Report
-- history" table on the new Tax & Reports page. Always written server-side
-- from the edge function's service-role client.
CREATE TABLE report_history (
  id           uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  report_type  text NOT NULL,
  period_from  date NOT NULL,
  period_to    date NOT NULL,
  format       text NOT NULL CHECK (format IN ('csv', 'pdf')),
  status       text NOT NULL DEFAULT 'ready',
  file_path    text,
  generated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_report_history_business ON report_history(business_id, created_at DESC);

ALTER TABLE report_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY rh_select ON report_history FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY rh_insert ON report_history FOR INSERT
  WITH CHECK (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));
