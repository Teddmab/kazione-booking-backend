-- 057_booking_notifications_analytics.sql
-- Owner booking notification email + Google Analytics 4 integration support

ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS booking_notification_email text,
  ADD COLUMN IF NOT EXISTS ga_measurement_id text;

-- Internal storefront page view tracking (supplement to GA4)
CREATE TABLE IF NOT EXISTS storefront_page_views (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id  uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  page         text        NOT NULL,     -- 'home', 'services', 'booking', 'confirmation'
  referrer     text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spv_business_created
  ON storefront_page_views(business_id, created_at DESC);
