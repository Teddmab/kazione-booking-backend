-- ---------------------------------------------------------------------------
-- 010_notification_tables.sql  -  notifications, translations, guest_sessions
-- ---------------------------------------------------------------------------

-- -- Notifications --------------------------------------------------------------
-- In-app notification feed. user_id targets a specific user; business_id
-- scopes to a business for broadcast-style alerts. metadata stores extra
-- context (e.g. appointment_id, link) without schema changes.
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}',
  is_read     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id, is_read);
CREATE INDEX idx_notifications_business    ON notifications(business_id, created_at DESC);

-- -- Translations (generic content i18n) ----------------------------------------
-- Polymorphic translation store for any translatable entity (service,
-- service_category, storefront). entity_type + entity_id + locale + field
-- form the unique key. The default-locale value lives on the entity row
-- itself; additional locales go here.
CREATE TABLE translations (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  entity_type translatable_entity NOT NULL,
  entity_id   uuid NOT NULL,
  locale      text NOT NULL,
  field       text NOT NULL,
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, locale, field)
);

CREATE INDEX idx_translations_entity ON translations(entity_type, entity_id, locale);

-- -- Guest Sessions (short-lived tokens for guest booking actions) ---------------
-- Allows unauthenticated guests to view/cancel their booking via a secure
-- token sent by email. Tokens expire after a configurable TTL.
CREATE TABLE guest_sessions (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  email       text NOT NULL,
  token       text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_guest_sessions_email_token ON guest_sessions(email, token);
CREATE INDEX idx_guest_sessions_expiry      ON guest_sessions(expires_at);

-- Cleanup function: deletes all guest sessions past their expiry.
-- Call from a pg_cron job or an edge function on a schedule.
CREATE OR REPLACE FUNCTION remove_expired_guest_sessions()
RETURNS int AS $$
DECLARE
  removed int;
BEGIN
  DELETE FROM guest_sessions
  WHERE expires_at < now();
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public;
