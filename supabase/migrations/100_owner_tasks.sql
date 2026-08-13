CREATE TABLE owner_tasks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type            text NOT NULL,
  ref_id          uuid,
  ref_type        text,
  title           text NOT NULL,
  body            jsonb DEFAULT '{}',
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES auth.users(id),
  resolution      jsonb DEFAULT '{}',
  snoozed_until   timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX idx_owner_tasks_business_unresolved
  ON owner_tasks (business_id, created_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE owner_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner_tasks_business_access"
  ON owner_tasks FOR ALL
  USING (business_id IN (
    SELECT business_id FROM business_members
    WHERE user_id = auth.uid() AND role IN ('owner', 'manager')
  ));
