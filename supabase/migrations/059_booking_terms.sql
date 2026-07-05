-- Owner-defined booking terms / rules shown to clients during storefront booking.
-- Clients must explicitly acknowledge before confirming — stamp stored on the appointment.

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS booking_terms text;

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

COMMENT ON COLUMN business_settings.booking_terms IS
  'Owner-written terms, refund rules, and service notes shown to clients during online booking. NULL = disabled.';

COMMENT ON COLUMN appointments.terms_accepted_at IS
  'Timestamp at which the client acknowledged the business booking terms during this booking.';
