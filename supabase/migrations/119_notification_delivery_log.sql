-- 119_notification_delivery_log.sql
--
-- S62 — Notification Delivery Audit Log.
--
-- The comms stack (Resend/MessageBird/Bird.com) is real and working, but
-- delivery success/failure was only console.error-logged, never persisted.
-- The existing `notifications` table is an in-app feed conflated with an
-- AI-response cache (ai-insights reuses it) — not a delivery-audit log for
-- outbound channels. This table is the tenant-scoped equivalent of
-- staff_action_log (111) / admin_audit_log (045) for outbound sends: when a
-- customer says "I never got my reminder", this lets support answer "did we
-- actually try, and did the provider accept it" without tailing prod logs.
--
-- Insert-only from edge functions (service role); no UPDATE or DELETE.

CREATE TABLE IF NOT EXISTS notification_delivery_log (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Nullable — not every send is appointment-scoped (e.g. staff invites).
  appointment_id       uuid        REFERENCES appointments(id) ON DELETE SET NULL,
  channel              text        NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  recipient_type       text        NOT NULL CHECK (recipient_type IN ('client', 'staff', 'owner')),
  -- Short machine-readable purpose, e.g. 'booking_reminder', 'staff_invite',
  -- 'owner_appointment_reminder', 'completion_reminder'.
  purpose              text        NOT NULL,
  status               text        NOT NULL CHECK (status IN ('sent', 'failed')),
  -- For cross-referencing with the Resend/MessageBird/Bird dashboards.
  provider_message_id  text,
  error_message        text,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_delivery_log_business_time
  ON notification_delivery_log (business_id, created_at DESC);

CREATE INDEX idx_notification_delivery_log_appointment
  ON notification_delivery_log (appointment_id);

ALTER TABLE notification_delivery_log ENABLE ROW LEVEL SECURITY;

-- Owner/manager of the business can read its log. No client/staff read
-- access — this is an internal support tool, and phone/email are already
-- on the appointment/client row, so this table doesn't duplicate PII beyond
-- what's structurally required (recipient_type, not the raw address).
CREATE POLICY "business_read_notification_delivery_log"
  ON notification_delivery_log FOR SELECT
  USING (
    business_id IN (SELECT get_my_business_ids())
    AND get_user_role(business_id) IN ('owner', 'manager')
  );

-- Inserts come exclusively from edge functions via service role (bypasses
-- RLS). No user-facing INSERT, UPDATE, or DELETE policies — append-only.
-- (This migration runs well after 054_inventory_rls_and_grants.sql's
-- `ALTER DEFAULT PRIVILEGES`, so `authenticated` automatically gets the
-- SELECT grant this table's RLS policy relies on — no explicit GRANT
-- needed, unlike admin_audit_log's 045-era gap fixed in 116.)

COMMENT ON TABLE notification_delivery_log IS
  'Tenant-scoped audit log of outbound notification send attempts (email/SMS/WhatsApp) and their outcome. Insert-only.';
