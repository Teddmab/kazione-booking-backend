-- ---------------------------------------------------------------------------
-- 009_storefront_tables.sql  -  storefronts, storefront_gallery, promotions,
--                               reviews
-- ---------------------------------------------------------------------------

-- -- Storefronts ---------------------------------------------------------------
-- Public-facing salon page for each business. One-to-one with businesses.
-- The sections JSONB column controls which blocks appear on the storefront.
-- marketplace_* fields power the Browse / featured-salon views.
CREATE TABLE storefronts (
  id                      uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id             uuid NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  slug                    text NOT NULL UNIQUE,
  title                   text NOT NULL,
  tagline                 text,
  description             text,
  extended_description    text,
  logo_url                text,
  cover_image_url         text,
  accent_color            text NOT NULL DEFAULT '#C9873E',
  is_published            boolean NOT NULL DEFAULT false,
  custom_domain           text UNIQUE,
  -- Contact info
  address                 text,
  city                    text,
  country_code            text,
  phone                   text,
  email                   text,
  website                 text,
  -- Marketplace listing
  marketplace_status      text NOT NULL DEFAULT 'draft',
  marketplace_featured    boolean NOT NULL DEFAULT false,
  marketplace_headline    text,
  marketplace_tags        text[] NOT NULL DEFAULT '{}',
  marketplace_categories  text[] NOT NULL DEFAULT '{}',
  -- Policies
  booking_policy          text,
  cancellation_policy     text,
  -- Section visibility
  sections                jsonb NOT NULL DEFAULT '{"hero":true,"about":true,"services":true,"promotions":true,"gallery":true,"team":true,"reviews":false,"booking":true}',
  -- SEO
  seo_title               text,
  seo_description         text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- slug uniqueness is enforced by the UNIQUE constraint above (implicit index)
CREATE INDEX idx_storefronts_marketplace ON storefronts(is_published, marketplace_status);

CREATE TRIGGER trg_storefronts_updated_at
  BEFORE UPDATE ON storefronts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- -- Storefront Gallery ---------------------------------------------------------
-- Ordered image gallery for the storefront page.
CREATE TABLE storefront_gallery (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  storefront_id   uuid NOT NULL REFERENCES storefronts(id) ON DELETE CASCADE,
  image_url       text NOT NULL,
  caption         text,
  display_order   int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_gallery_storefront ON storefront_gallery(storefront_id, display_order);

-- -- Promotions -----------------------------------------------------------------
-- Time-bound discount offers displayed on the storefront. applies_to holds
-- an array of service UUIDs; empty means the promo applies to all services.
CREATE TABLE promotions (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title           text NOT NULL,
  description     text,
  discount_type   text NOT NULL DEFAULT 'percentage',
  discount_value  numeric(10,2) NOT NULL,
  badge           text,
  valid_from      date,
  valid_until     date,
  is_active       boolean NOT NULL DEFAULT true,
  applies_to      uuid[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_promotions_business ON promotions(business_id, is_active);

-- -- Reviews -------------------------------------------------------------------
-- Client reviews tied to a specific appointment (one review per appointment).
-- owner_reply lets the business respond publicly.
CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  client_id       uuid REFERENCES clients(id) ON DELETE SET NULL,
  appointment_id  uuid UNIQUE REFERENCES appointments(id) ON DELETE SET NULL,
  rating          int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         text,
  is_public       boolean NOT NULL DEFAULT true,
  owner_reply     text,
  replied_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_reviews_business ON reviews(business_id, is_public);
