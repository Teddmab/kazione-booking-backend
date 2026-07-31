-- Add payment tracking to fixed costs entries
ALTER TABLE fixed_costs ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE fixed_costs ADD COLUMN IF NOT EXISTS payment_method text;
