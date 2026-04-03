-- ─────────────────────────────────────────────────────────────────────────────
-- 003_service_catalog.sql  –  service_categories, services, service_translations
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Service Categories ───────────────────────────────────────────────────────
-- Groupings for services (e.g. "Braids", "Locs", "Treatments").
-- When business_id IS NULL the category is a global/system-level default
-- available to all businesses; otherwise it belongs to a single business.
CREATE TABLE service_categories (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id   uuid REFERENCES businesses(id) ON DELETE CASCADE,  -- NULL = global
  name          text NOT NULL,
  icon          text,                           -- lucide icon name
  display_order int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE service_categories IS 'Service groupings; NULL business_id = global/system category.';

CREATE INDEX idx_service_categories_business ON service_categories(business_id);

-- ── Services ─────────────────────────────────────────────────────────────────
-- Individual bookable services offered by a business (e.g. "Knotless Braids").
-- duration_minutes drives availability slot calculation; deposit_amount
-- overrides the business-level default when set.
CREATE TABLE services (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  category_id         uuid REFERENCES service_categories(id) ON DELETE SET NULL,
  name                text NOT NULL,
  description         text,
  duration_minutes    int NOT NULL,
  price               numeric(10,2) NOT NULL,
  currency_code       text NOT NULL DEFAULT 'EUR',
  deposit_amount      numeric(10,2),            -- NULL = use business_settings default
  is_active           boolean NOT NULL DEFAULT true,
  is_public           boolean NOT NULL DEFAULT true,
  image_url           text,
  display_order       int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE services IS 'Bookable services offered by a business. Drives availability and pricing.';

CREATE INDEX idx_services_business_active   ON services(business_id, is_active);
CREATE INDEX idx_services_business_category ON services(business_id, category_id);

CREATE TRIGGER trg_services_updated_at
  BEFORE UPDATE ON services
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ── Service Translations ─────────────────────────────────────────────────────
-- Stores per-locale overrides for translatable service fields (name, description).
-- The default language lives in the services row itself; additional locales go here.
CREATE TABLE service_translations (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  locale      text NOT NULL,   -- 'en', 'et', 'fr'
  field       text NOT NULL,   -- 'name', 'description'
  value       text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_id, locale, field)
);

COMMENT ON TABLE service_translations IS 'Per-locale overrides for service name/description.';

CREATE INDEX idx_service_translations_lookup ON service_translations(service_id, locale);

CREATE TRIGGER trg_service_translations_updated_at
  BEFORE UPDATE ON service_translations
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
