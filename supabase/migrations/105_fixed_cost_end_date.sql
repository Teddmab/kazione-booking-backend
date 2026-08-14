-- Migration 105: add end_date to fixed_costs so recurring costs can be "stopped"
-- without deleting historical entries.

ALTER TABLE fixed_costs
  ADD COLUMN IF NOT EXISTS end_date date;

COMMENT ON COLUMN fixed_costs.end_date IS
  'When set, the cost is considered stopped after this date. History is preserved.';
