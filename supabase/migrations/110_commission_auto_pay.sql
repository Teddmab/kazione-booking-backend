-- Business-wide toggle: automatically mark commission as paid when appointment is completed.
-- commission_auto_pay_method mirrors the allowed values for commission_pay_method on appointments.
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS commission_auto_pay        boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS commission_auto_pay_method text    NOT NULL DEFAULT 'cash';
