-- Owner settings UI columns (parity with web useBusinessSettings + mobile M10)

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS operating_hours JSONB DEFAULT NULL;

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS notify_new_booking     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notify_cancellation    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notify_daily_summary   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notify_weekly_report   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notify_client_message  BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS admin_locale       TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS storefront_locale  TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS currency_code      TEXT NOT NULL DEFAULT 'EUR',
  ADD COLUMN IF NOT EXISTS date_format        TEXT NOT NULL DEFAULT 'dmy';

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS allow_pay_later     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_confirm        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS buffer_minutes      INTEGER NOT NULL DEFAULT 0;
