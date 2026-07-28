-- Sprint 5: SMS + WhatsApp notification tracking
-- Adds per-appointment sent-at timestamps so reminders aren't double-sent,
-- and per-business opt-in toggles for the owner settings UI.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_sms_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reminder_whatsapp_sent_at timestamptz;

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS sms_notifications_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_notifications_enabled boolean NOT NULL DEFAULT false;
