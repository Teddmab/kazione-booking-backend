-- 151_financial_periods.sql
-- Per-business-per-month bookkeeping lock. One row per (business, month);
-- absence of a row (or status='open') means the month is still editable —
-- most months never get a row at all. Reopening overwrites the previous
-- close's audit fields rather than keeping a full history, which is
-- sufficient for "is this month locked right now, and who last closed or
-- reopened it," the only thing the UI needs.

CREATE TABLE financial_periods (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period_month  date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at     timestamptz,
  closed_by     uuid REFERENCES auth.users(id),
  close_note    text,
  reopened_at   timestamptz,
  reopened_by   uuid REFERENCES auth.users(id),
  reopen_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_periods_month_is_first_of_month
    CHECK (period_month = date_trunc('month', period_month)::date),
  UNIQUE (business_id, period_month)
);

CREATE INDEX idx_financial_periods_business ON financial_periods(business_id);

CREATE TRIGGER trg_financial_periods_updated_at
  BEFORE UPDATE ON financial_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE financial_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY financial_periods_owner_manager ON financial_periods
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM business_members bm
      WHERE bm.business_id = financial_periods.business_id
        AND bm.user_id = auth.uid()
        AND bm.role IN ('owner', 'manager')
        AND bm.is_active = true
    )
  );
