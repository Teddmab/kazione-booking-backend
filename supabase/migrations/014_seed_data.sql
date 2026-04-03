-- ---------------------------------------------------------------------------
-- 014_seed_data.sql  -  Global service categories + development test data
-- ---------------------------------------------------------------------------


-- =========================================================================
-- PART 1: Global service categories (business_id IS NULL)
-- Available to every business as default/template categories.
-- =========================================================================

-- Hair
INSERT INTO service_categories (id, business_id, name, icon, display_order)
VALUES
  ('a0000000-0000-4000-8000-000000000001', NULL, 'Haircut',              'scissors',     1),
  ('a0000000-0000-4000-8000-000000000002', NULL, 'Colour & Highlights',  'palette',      2),
  ('a0000000-0000-4000-8000-000000000003', NULL, 'Braiding & Weaving',   'waves',        3),
  ('a0000000-0000-4000-8000-000000000004', NULL, 'Locs & Dreadlocks',    'link',         4),
  ('a0000000-0000-4000-8000-000000000005', NULL, 'Natural Hair',         'leaf',         5),
  ('a0000000-0000-4000-8000-000000000006', NULL, 'Blowout & Styling',    'wind',         6)
ON CONFLICT DO NOTHING;

-- Nails
INSERT INTO service_categories (id, business_id, name, icon, display_order)
VALUES
  ('a0000000-0000-4000-8000-000000000011', NULL, 'Manicure',     'hand',        1),
  ('a0000000-0000-4000-8000-000000000012', NULL, 'Pedicure',     'footprints',  2),
  ('a0000000-0000-4000-8000-000000000013', NULL, 'Gel Nails',    'sparkles',    3),
  ('a0000000-0000-4000-8000-000000000014', NULL, 'Acrylic Nails','gem',         4),
  ('a0000000-0000-4000-8000-000000000015', NULL, 'Nail Art',     'brush',       5)
ON CONFLICT DO NOTHING;

-- Skin
INSERT INTO service_categories (id, business_id, name, icon, display_order)
VALUES
  ('a0000000-0000-4000-8000-000000000021', NULL, 'Facial',               'smile',        1),
  ('a0000000-0000-4000-8000-000000000022', NULL, 'Chemical Peel',        'flask-conical', 2),
  ('a0000000-0000-4000-8000-000000000023', NULL, 'Microdermabrasion',    'scan',         3),
  ('a0000000-0000-4000-8000-000000000024', NULL, 'Eyebrow Threading',    'pen-tool',     4),
  ('a0000000-0000-4000-8000-000000000025', NULL, 'Eyebrow Tinting',      'droplets',     5)
ON CONFLICT DO NOTHING;

-- Body
INSERT INTO service_categories (id, business_id, name, icon, display_order)
VALUES
  ('a0000000-0000-4000-8000-000000000031', NULL, 'Massage',              'heart-pulse',  1),
  ('a0000000-0000-4000-8000-000000000032', NULL, 'Waxing',               'flame',        2),
  ('a0000000-0000-4000-8000-000000000033', NULL, 'Body Wrap & Scrub',    'bath',         3)
ON CONFLICT DO NOTHING;

-- Lash & Brow
INSERT INTO service_categories (id, business_id, name, icon, display_order)
VALUES
  ('a0000000-0000-4000-8000-000000000041', NULL, 'Lash Extensions',      'eye',          1),
  ('a0000000-0000-4000-8000-000000000042', NULL, 'Lash Lift',            'trending-up',  2),
  ('a0000000-0000-4000-8000-000000000043', NULL, 'Brow Lamination',      'layers',       3),
  ('a0000000-0000-4000-8000-000000000044', NULL, 'Tinting',              'droplet',      4)
ON CONFLICT DO NOTHING;

-- Barber
INSERT INTO service_categories (id, business_id, name, icon, display_order)
VALUES
  ('a0000000-0000-4000-8000-000000000051', NULL, 'Men''s Haircut',       'scissors',     1),
  ('a0000000-0000-4000-8000-000000000052', NULL, 'Beard Trim',           'axe',          2),
  ('a0000000-0000-4000-8000-000000000053', NULL, 'Hot Towel Shave',      'thermometer',  3),
  ('a0000000-0000-4000-8000-000000000054', NULL, 'Line Up',              'ruler',        4)
ON CONFLICT DO NOTHING;


-- =========================================================================
-- PART 2: Development test data (idempotent — only inserts once)
-- =========================================================================

DO $$
DECLARE
  v_biz_id    uuid := 'b0000000-0000-4000-8000-000000000001';
  v_svc1_id   uuid := 'c0000000-0000-4000-8000-000000000001';
  v_svc2_id   uuid := 'c0000000-0000-4000-8000-000000000002';
  v_svc3_id   uuid := 'c0000000-0000-4000-8000-000000000003';
  v_svc4_id   uuid := 'c0000000-0000-4000-8000-000000000004';
  v_staff1_id uuid := 'd0000000-0000-4000-8000-000000000001';
  v_staff2_id uuid := 'd0000000-0000-4000-8000-000000000002';
  v_sf_id     uuid := 'e0000000-0000-4000-8000-000000000001';
  v_cat_braids uuid := 'a0000000-0000-4000-8000-000000000003';  -- Braiding & Weaving
  v_cat_locs   uuid := 'a0000000-0000-4000-8000-000000000004';  -- Locs & Dreadlocks
  v_cat_natural uuid := 'a0000000-0000-4000-8000-000000000005'; -- Natural Hair
BEGIN
  -- Guard: skip if business already exists
  IF EXISTS (SELECT 1 FROM businesses WHERE id = v_biz_id) THEN
    RAISE NOTICE 'Seed data already exists — skipping.';
    RETURN;
  END IF;

  -- ── Test business ─────────────────────────────────────────────────────────
  INSERT INTO businesses (id, name, slug, industry, timezone, locale, currency_code)
  VALUES (v_biz_id, 'Afrotouch Tallinn', 'afrotouch', 'afro_salon',
          'Europe/Tallinn', 'en', 'EUR')
  ON CONFLICT DO NOTHING;

  -- ── Business settings ─────────────────────────────────────────────────────
  INSERT INTO business_settings (
    business_id,
    slot_duration_minutes,
    booking_lead_time_hours,
    booking_future_days,
    cancellation_hours,
    reschedule_hours,
    deposit_percentage,
    tax_enabled,
    tax_rate,
    tax_label,
    reminder_email_enabled,
    reminder_hours_before,
    working_days
  ) VALUES (
    v_biz_id,
    30,          -- 30-min slot grid
    2,           -- 2h lead time
    60,          -- 60 days ahead
    24,          -- 24h cancellation window
    24,          -- 24h reschedule window
    25.00,       -- 25% deposit
    true,        -- tax enabled
    20.00,       -- 20% VAT (Estonia)
    'VAT',
    true,
    24,
    '{1,2,3,4,5,6}'  -- Mon-Sat
  )
  ON CONFLICT (business_id) DO NOTHING;

  -- ── Test services (matching storefrontData.ts prices) ─────────────────────
  INSERT INTO services (id, business_id, category_id, name, description,
                        duration_minutes, price, currency_code, is_active, is_public)
  VALUES
    (v_svc1_id, v_biz_id, v_cat_braids,
     'Knotless Braids',
     'Lightweight, natural-looking braids using the feed-in technique for less tension on the scalp.',
     180, 120.00, 'EUR', true, true),
    (v_svc2_id, v_biz_id, v_cat_braids,
     'Box Braids',
     'Classic box braids in various sizes. Includes wash, condition, and styling.',
     150, 90.00, 'EUR', true, true),
    (v_svc3_id, v_biz_id, v_cat_locs,
     'Loc Maintenance',
     'Retwist, interlocking, or palm-rolling maintenance for established locs.',
     120, 75.00, 'EUR', true, true),
    (v_svc4_id, v_biz_id, v_cat_natural,
     'Natural Hair Consultation',
     'One-on-one consultation to assess hair health, discuss goals, and create a care plan.',
     60, 40.00, 'EUR', true, true)
  ON CONFLICT DO NOTHING;

  -- ── Test staff profiles ───────────────────────────────────────────────────
  INSERT INTO staff_profiles (id, business_id, display_name, bio, specialties,
                              commission_rate, calendar_color, is_active)
  VALUES
    (v_staff1_id, v_biz_id, 'Fatima K.',
     'Senior braiding specialist with 8+ years experience in protective styles.',
     ARRAY['Knotless Braids', 'Box Braids', 'Cornrows'],
     15.00, '#8B5CF6', true),
    (v_staff2_id, v_biz_id, 'Regina M.',
     'Loc and natural hair expert. Certified trichologist.',
     ARRAY['Locs', 'Natural Hair', 'Loc Maintenance'],
     12.00, '#EC4899', true)
  ON CONFLICT DO NOTHING;

  -- ── Staff ↔ service mapping ───────────────────────────────────────────────
  INSERT INTO staff_services (staff_profile_id, service_id)
  VALUES
    (v_staff1_id, v_svc1_id),  -- Fatima → Knotless Braids
    (v_staff1_id, v_svc2_id),  -- Fatima → Box Braids
    (v_staff2_id, v_svc3_id),  -- Regina → Loc Maintenance
    (v_staff2_id, v_svc4_id)   -- Regina → Natural Hair Consultation
  ON CONFLICT DO NOTHING;

  -- ── Staff working hours (Mon-Sat 10:00-19:00) ─────────────────────────────
  INSERT INTO staff_working_hours (staff_profile_id, business_id, day_of_week,
                                   start_time, end_time, is_working)
  SELECT s.id, v_biz_id, d.dow, '10:00'::time, '19:00'::time, true
    FROM (VALUES (v_staff1_id), (v_staff2_id)) AS s(id),
         (VALUES (1),(2),(3),(4),(5),(6)) AS d(dow)  -- Mon-Sat
  ON CONFLICT DO NOTHING;

  -- Sunday off
  INSERT INTO staff_working_hours (staff_profile_id, business_id, day_of_week,
                                   start_time, end_time, is_working)
  SELECT s.id, v_biz_id, 0, NULL, NULL, false
    FROM (VALUES (v_staff1_id), (v_staff2_id)) AS s(id)
  ON CONFLICT DO NOTHING;

  -- ── Test storefront ───────────────────────────────────────────────────────
  INSERT INTO storefronts (
    id, business_id, slug, title, tagline,
    description,
    extended_description,
    accent_color, is_published, marketplace_status, marketplace_featured,
    marketplace_headline,
    marketplace_tags,
    marketplace_categories,
    address, city, country_code, phone, email, website,
    sections
  ) VALUES (
    v_sf_id, v_biz_id, 'afrotouch',
    'Afrotouch Tallinn',
    'Afro-Textured Hair Specialists',
    'Tallinn''s premier salon specialising in afro-textured hair care, braiding, locs, and natural hair services.',
    'Founded in 2021, Afrotouch is Tallinn''s first salon dedicated exclusively to afro-textured hair. Our team of expert stylists brings together years of international experience to provide premium protective styling, loc maintenance, and natural hair care in a warm, welcoming environment.',
    '#C9873E', true, 'active', true,
    'Premium Afro-Textured Hair Care in Tallinn',
    ARRAY['Braids', 'Locs', 'Natural Hair', 'Protective Styles'],
    ARRAY['Hair', 'Braids', 'Natural Hair'],
    'Telliskivi 60a', 'Tallinn', 'EE',
    '+372 5123 4567', 'hello@afrotouch.ee', 'https://afrotouch.ee',
    '{"hero":true,"about":true,"services":true,"promotions":true,"gallery":true,"team":true,"reviews":true,"booking":true}'::jsonb
  )
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Seed data inserted for Afrotouch Tallinn (%).', v_biz_id;
END $$;
