-- ---------------------------------------------------------------------------
-- supabase/seed.sql  —  Local development test accounts
-- Runs automatically after all migrations on `supabase start` / `db reset`.
-- DO NOT commit real credentials. These are local-only throwaway accounts.
-- ---------------------------------------------------------------------------

-- ── Test owner account ───────────────────────────────────────────────────────
-- Email:    owner@afrotouch.ee
-- Password: Test1234!
-- Role:     owner of Afrotouch Tallinn (b0000000-0000-4000-8000-000000000001)

DO $$
DECLARE
  v_user_id uuid := 'f0000000-0000-4000-8000-000000000001';
  v_biz_id  uuid := 'b0000000-0000-4000-8000-000000000001';
BEGIN
  -- Skip if already seeded
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RAISE NOTICE 'Seed user already exists — skipping.';
    RETURN;
  END IF;

  -- 1. Create auth user (bcrypt password via pgcrypto)
  INSERT INTO auth.users (
    instance_id, id, aud, role,
    email, encrypted_password,
    email_confirmed_at,
    confirmation_token, recovery_token,
    email_change, email_change_token_new, email_change_token_current,
    phone, phone_change, reauthentication_token,
    created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    is_sso_user, is_super_admin
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated', 'authenticated',
    'owner@afrotouch.ee',
    crypt('Test1234!', gen_salt('bf')),
    now(),           -- email pre-confirmed for local dev
    '', '',
    '', '', '',
    NULL, '', '',
    now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"first_name":"Teddy","last_name":"Owner"}',
    false, false
  );

  -- 2. Public users row (handle_new_user trigger fires on auth insert,
  --    but insert here too in case trigger order is unpredictable in seeds)
  INSERT INTO public.users (id, email, first_name, last_name)
  VALUES (v_user_id, 'owner@afrotouch.ee', 'Teddy', 'Owner')
  ON CONFLICT (id) DO NOTHING;

  -- 3. Owner membership for the seed business
  INSERT INTO business_members (business_id, user_id, role, is_active, joined_at)
  VALUES (v_biz_id, v_user_id, 'owner', true, now())
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Seed owner account created: owner@afrotouch.ee / Test1234!';
END $$;

-- ── Test customer account ─────────────────────────────────────────────────────
-- Email:    customer@test.com
-- Password: Test1234!
-- Role:     none (no business_members row) → routes to /client after login

DO $$
DECLARE
  v_user_id uuid := 'f0000000-0000-4000-8000-000000000002';
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RAISE NOTICE 'Seed customer already exists — skipping.';
    RETURN;
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role,
    email, encrypted_password,
    email_confirmed_at,
    confirmation_token, recovery_token,
    email_change, email_change_token_new, email_change_token_current,
    phone, phone_change, reauthentication_token,
    created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    is_sso_user, is_super_admin
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated', 'authenticated',
    'customer@test.com',
    crypt('Test1234!', gen_salt('bf')),
    now(),
    '', '',
    '', '', '',
    NULL, '', '',
    now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"first_name":"Test","last_name":"Customer"}',
    false, false
  );

  INSERT INTO public.users (id, email, first_name, last_name)
  VALUES (v_user_id, 'customer@test.com', 'Test', 'Customer')
  ON CONFLICT (id) DO NOTHING;

  -- No business_members row → TenantContext returns null → routes to /client

  RAISE NOTICE 'Seed customer account created: customer@test.com / Test1234!';
END $$;

-- ── Test clients + appointments ───────────────────────────────────────────────
-- Relative to NOW() so they always appear in today / this-week views.

DO $$
DECLARE
  v_biz_id    uuid := 'b0000000-0000-4000-8000-000000000001';
  v_svc1_id   uuid := 'c0000000-0000-4000-8000-000000000001'; -- Knotless Braids  180min €120
  v_svc2_id   uuid := 'c0000000-0000-4000-8000-000000000002'; -- Box Braids       150min €90
  v_svc3_id   uuid := 'c0000000-0000-4000-8000-000000000003'; -- Loc Maintenance  120min €75
  v_svc4_id   uuid := 'c0000000-0000-4000-8000-000000000004'; -- Hair Consultation 60min €40
  v_staff1_id uuid := 'd0000000-0000-4000-8000-000000000001'; -- Fatima K.
  v_staff2_id uuid := 'd0000000-0000-4000-8000-000000000002'; -- Regina M.

  v_cl1_id uuid := 'c1000000-0000-4000-8000-000000000001';
  v_cl2_id uuid := 'c1000000-0000-4000-8000-000000000002';
  v_cl3_id uuid := 'c1000000-0000-4000-8000-000000000003';
  v_cl4_id uuid := 'c1000000-0000-4000-8000-000000000004';
  v_cl5_id uuid := 'c1000000-0000-4000-8000-000000000005';

  today     date := current_date;
BEGIN
  -- Guard: skip if test clients already exist
  IF EXISTS (SELECT 1 FROM clients WHERE id = v_cl1_id) THEN
    RAISE NOTICE 'Seed clients already exist — skipping.';
    RETURN;
  END IF;

  -- ── Clients ────────────────────────────────────────────────────────────────
  INSERT INTO clients (id, business_id, first_name, last_name, email, phone, source)
  VALUES
    (v_cl1_id, v_biz_id, 'Amara',   'Diallo',   'amara.diallo@email.com',   '+372 5111 0001', 'marketplace'),
    (v_cl2_id, v_biz_id, 'Sophie',  'Martin',   'sophie.martin@email.com',  '+372 5111 0002', 'online'),
    (v_cl3_id, v_biz_id, 'Kezia',   'Osei',     'kezia.osei@email.com',     '+372 5111 0003', 'referral'),
    (v_cl4_id, v_biz_id, 'Isabelle','Laurent',  'isabelle.l@email.com',     '+372 5111 0004', 'walk_in'),
    (v_cl5_id, v_biz_id, 'Nadia',   'Tremblay', 'nadia.t@email.com',        '+372 5111 0005', 'marketplace')
  ON CONFLICT DO NOTHING;

  -- ── Today's appointments ───────────────────────────────────────────────────
  -- 10:00 – confirmed (Knotless Braids, Fatima)
  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference, notes)
  VALUES (
    v_biz_id, v_cl1_id, v_staff1_id, v_svc1_id, 'confirmed',
    (today || ' 10:00:00')::timestamptz,
    (today || ' 13:00:00')::timestamptz,
    180, 120.00, 30.00,
    'online', 'AT-TODAY-001', 'Prefers hip-length braids'
  ) ON CONFLICT DO NOTHING;

  -- 11:00 – confirmed (Hair Consultation, Regina)
  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference)
  VALUES (
    v_biz_id, v_cl2_id, v_staff2_id, v_svc4_id, 'confirmed',
    (today || ' 11:00:00')::timestamptz,
    (today || ' 12:00:00')::timestamptz,
    60, 40.00, 0.00,
    'online', 'AT-TODAY-002'
  ) ON CONFLICT DO NOTHING;

  -- 13:30 – pending (Box Braids, Fatima)
  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference)
  VALUES (
    v_biz_id, v_cl3_id, v_staff1_id, v_svc2_id, 'pending',
    (today || ' 13:30:00')::timestamptz,
    (today || ' 16:00:00')::timestamptz,
    150, 90.00, 22.50,
    'marketplace', 'AT-TODAY-003'
  ) ON CONFLICT DO NOTHING;

  -- 15:00 – confirmed (Loc Maintenance, Regina)
  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference)
  VALUES (
    v_biz_id, v_cl4_id, v_staff2_id, v_svc3_id, 'confirmed',
    (today || ' 15:00:00')::timestamptz,
    (today || ' 17:00:00')::timestamptz,
    120, 75.00, 0.00,
    'walk_in', 'AT-TODAY-004'
  ) ON CONFLICT DO NOTHING;

  -- ── Tomorrow ───────────────────────────────────────────────────────────────
  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference)
  VALUES (
    v_biz_id, v_cl5_id, v_staff1_id, v_svc1_id, 'confirmed',
    (today + 1 || ' 10:00:00')::timestamptz,
    (today + 1 || ' 13:00:00')::timestamptz,
    180, 120.00, 30.00,
    'marketplace', 'AT-TMR-001'
  ) ON CONFLICT DO NOTHING;

  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference)
  VALUES (
    v_biz_id, v_cl2_id, v_staff2_id, v_svc3_id, 'confirmed',
    (today + 1 || ' 14:00:00')::timestamptz,
    (today + 1 || ' 16:00:00')::timestamptz,
    120, 75.00, 0.00,
    'online', 'AT-TMR-002'
  ) ON CONFLICT DO NOTHING;

  -- ── Later this week ────────────────────────────────────────────────────────
  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference)
  VALUES (
    v_biz_id, v_cl3_id, v_staff2_id, v_svc4_id, 'confirmed',
    (today + 3 || ' 11:00:00')::timestamptz,
    (today + 3 || ' 12:00:00')::timestamptz,
    60, 40.00, 0.00,
    'online', 'AT-WEEK-001'
  ) ON CONFLICT DO NOTHING;

  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference)
  VALUES (
    v_biz_id, v_cl1_id, v_staff1_id, v_svc2_id, 'pending',
    (today + 4 || ' 10:30:00')::timestamptz,
    (today + 4 || ' 13:00:00')::timestamptz,
    150, 90.00, 22.50,
    'marketplace', 'AT-WEEK-002'
  ) ON CONFLICT DO NOTHING;

  -- ── Yesterday (completed + no_show for history) ────────────────────────────
  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference)
  VALUES (
    v_biz_id, v_cl4_id, v_staff1_id, v_svc1_id, 'completed',
    (today - 1 || ' 10:00:00')::timestamptz,
    (today - 1 || ' 13:00:00')::timestamptz,
    180, 120.00, 30.00,
    'online', 'AT-HIST-001'
  ) ON CONFLICT DO NOTHING;

  INSERT INTO appointments
    (business_id, client_id, staff_profile_id, service_id, status,
     starts_at, ends_at, duration_minutes, price, deposit_amount,
     booking_source, booking_reference)
  VALUES (
    v_biz_id, v_cl5_id, v_staff2_id, v_svc3_id, 'no_show',
    (today - 1 || ' 14:00:00')::timestamptz,
    (today - 1 || ' 16:00:00')::timestamptz,
    120, 75.00, 0.00,
    'marketplace', 'AT-HIST-002'
  ) ON CONFLICT DO NOTHING;

  -- ── Payments for confirmed/completed appointments ──────────────────────────
  INSERT INTO payments (business_id, appointment_id, client_id, amount, currency_code,
                        status, method)
  SELECT v_biz_id, a.id, a.client_id, a.deposit_amount, 'EUR', 'paid', 'card'
    FROM appointments a
   WHERE a.business_id = v_biz_id
     AND a.booking_reference IN ('AT-TODAY-001','AT-TODAY-002','AT-TODAY-004',
                                  'AT-TMR-001','AT-TMR-002','AT-WEEK-001',
                                  'AT-HIST-001')
     AND a.deposit_amount > 0
     AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.appointment_id = a.id)
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Seed appointments + clients inserted for Afrotouch Tallinn.';
END $$;

-- ── Link the seeded test customer to a real client record ─────────────────────
-- Amara Diallo's client row (above) previously had no linked user_id, so
-- get-booking.test.ts's and gdpr.test.ts's "authenticated client's own JWT"
-- tests were permanently gated behind a TEST_CLIENT_TOKEN env var that
-- nothing ever set — the client-authenticated view of a booking had zero
-- live CI coverage. Linking her to the seeded customer@test.com account
-- (created above) gives those tests a real, hardcoded fixture and lets
-- ci.yml mint an actual client JWT the same way it already does for the
-- owner and platform-admin tokens.
UPDATE clients
SET user_id = 'f0000000-0000-4000-8000-000000000002'
WHERE id = 'c1000000-0000-4000-8000-000000000001'
  AND user_id IS NULL;

-- ── Foreign test business + client (S74) ──────────────────────────────────────
-- Exists purely so cross-business test cases (clients.test.ts) have a REAL,
-- distinct business/client pair to assert against, instead of skipping when
-- no such fixture is available. Deliberately minimal — no settings, services,
-- or staff, since those tests never exercise this business's own operations.

DO $$
DECLARE
  v_foreign_biz_id uuid := 'b0000000-0000-4000-8000-000000000002';
  v_foreign_cl_id  uuid := 'c2000000-0000-4000-8000-000000000001';
BEGIN
  IF EXISTS (SELECT 1 FROM businesses WHERE id = v_foreign_biz_id) THEN
    RAISE NOTICE 'Foreign test business already exists — skipping.';
    RETURN;
  END IF;

  INSERT INTO businesses (id, name, slug, industry, timezone, locale, currency_code)
  VALUES (v_foreign_biz_id, 'Foreign Test Salon', 'foreign-test-salon', 'afro_salon',
          'Europe/Tallinn', 'en', 'EUR')
  ON CONFLICT DO NOTHING;

  INSERT INTO clients (id, business_id, first_name, last_name, email, phone, source)
  VALUES (v_foreign_cl_id, v_foreign_biz_id, 'Foreign', 'Client',
          'foreign.client@email.com', '+372 5111 9999', 'manual')
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Foreign test business + client seeded (S74 cross-business fixtures).';
END $$;

-- ── Give a seeded staff profile a resolvable email (S74) ──────────────────────
-- Fatima K.'s profile (migration 014_seed_data.sql) has no linked
-- business_member_id and no invited_email — fine for display/booking
-- purposes (she's never meant to log in), but staff?action=magic-link
-- (S57) needs SOME resolvable email to send a sign-in link to. Confirmed
-- via CI (S74) that this — not a missing row — was why that test 404'd:
-- the profile exists and is active, it just had nowhere to send a link.
UPDATE staff_profiles
SET invited_email = 'fatima.k@test.kazione.local'
WHERE id = 'd0000000-0000-4000-8000-000000000001'
  AND business_member_id IS NULL
  AND invited_email IS NULL;

-- ── Africa/Kampala test business (S59) ─────────────────────────────────────
-- A second real, working business — not just a business+client stub like the
-- Foreign Test Salon above — deliberately at Africa/Kampala (UTC+3, no DST)
-- so a residual false-UTC bug shows as a clean 3-hour shift with no DST
-- noise to obscure it. One active service, one active staff profile,
-- working hours Monday 09:00-17:00 local. 2026-10-05 is a Monday (day_of_week
-- = 1), chosen to sit outside every other test file's date range
-- (create-booking: 2026-06-08, reschedule-booking: 2026-09, appointments:
-- 2026-10-05 onward — shares appointments.test.ts's range deliberately,
-- since both exercise the same booking-creation paths and won't collide on
-- business/staff/service ids).
DO $$
DECLARE
  v_kampala_biz_id  uuid := 'b0000000-0000-4000-8000-000000000003';
  v_kampala_svc_id  uuid := 'c0000000-0000-4000-8000-000000000006';
  v_kampala_staff_id uuid := 'd0000000-0000-4000-8000-000000000003';
BEGIN
  IF EXISTS (SELECT 1 FROM businesses WHERE id = v_kampala_biz_id) THEN
    RAISE NOTICE 'Kampala test business already exists — skipping.';
    RETURN;
  END IF;

  INSERT INTO businesses (id, name, slug, industry, timezone, locale, currency_code)
  VALUES (v_kampala_biz_id, 'Kampala Test Salon', 'kampala-test-salon', 'afro_salon',
          'Africa/Kampala', 'en', 'UGX')
  ON CONFLICT DO NOTHING;

  INSERT INTO business_settings (business_id, slot_duration_minutes, booking_lead_time_hours, booking_future_days)
  VALUES (v_kampala_biz_id, 30, 2, 365)
  ON CONFLICT DO NOTHING;

  INSERT INTO services (id, business_id, name, duration_minutes, price, currency_code, is_active, is_public)
  VALUES (v_kampala_svc_id, v_kampala_biz_id, 'Kampala Test Service', 60, 20000.00, 'UGX', true, true)
  ON CONFLICT DO NOTHING;

  INSERT INTO staff_profiles (id, business_id, display_name, is_active)
  VALUES (v_kampala_staff_id, v_kampala_biz_id, 'Kampala Test Staff', true)
  ON CONFLICT DO NOTHING;

  INSERT INTO staff_services (staff_profile_id, service_id)
  VALUES (v_kampala_staff_id, v_kampala_svc_id)
  ON CONFLICT DO NOTHING;

  -- Monday (day_of_week = 1), 09:00-17:00 local (Africa/Kampala).
  INSERT INTO staff_working_hours (staff_profile_id, business_id, day_of_week, start_time, end_time, is_working)
  VALUES (v_kampala_staff_id, v_kampala_biz_id, 1, '09:00', '17:00', true)
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Kampala test business + service + staff + working hours seeded (S59 timezone fixtures).';
END $$;

-- ── Dual-staff test service (S58) ──────────────────────────────────────────
-- A minimal, otherwise-unused service with requires_two_staff = true so
-- appointments.test.ts can exercise assign-staff-2's conflict-check path.
-- Deliberately separate from svc1-svc4 (which many other tests depend on
-- behaving exactly as before) rather than flipping an existing service's
-- flag.
INSERT INTO services (id, business_id, name, duration_minutes, price, currency_code, is_active, is_public, requires_two_staff)
VALUES ('c0000000-0000-4000-8000-000000000005', 'b0000000-0000-4000-8000-000000000001',
        'S58 Test — Dual Staff Service', 60, 50.00, 'EUR', true, false, true)
ON CONFLICT DO NOTHING;

-- ── Fixed-id appointment with a staff member assigned (get-booking fix) ────
-- get-booking.test.ts's real-fetch tests (the ones that actually exercise
-- the authenticated 200 path — auth, cancel-token, embedded relations) were
-- entirely gated behind TEST_APPT_ID/TEST_APPT_CANCEL_TOKEN/TEST_CLIENT_TOKEN
-- env vars CI never sets, so they silently skipped forever. That's why a
-- genuine bug (staff:staff_profiles(...) with no !staff_profile_id hint,
-- ambiguous against staff_profile_id_2/referrer_staff_id since migration
-- 086 — PostgREST 500s with "more than one relationship was found") shipped
-- undetected. Fixed id + a real assigned staff member so a hardcoded test
-- can exercise that exact embed instead of an env-gated skip.
--
-- 2026-11-02 is deliberately outside every other test file's date range
-- (create-booking: 2026-06-08 + 2026-10-12 Kampala; reschedule-booking:
-- 2026-09; appointments.test.ts: 2026-10-05..08) — this is a direct SQL
-- INSERT, not a booking-flow call, but the conflict-lock RPCs those other
-- tests exercise still check against ANY existing row for the same staff,
-- so a colliding time/staff pair (even converted through S59's now-correct
-- Europe/Tallinn UTC offset) would spuriously block a real test elsewhere.
INSERT INTO appointments
  (id, business_id, client_id, staff_profile_id, service_id, status,
   starts_at, ends_at, duration_minutes, price, deposit_amount,
   booking_source, booking_reference)
VALUES (
  'f0000000-0000-4000-8000-000000000099',
  'b0000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001',
  'confirmed',
  '2026-11-02T10:00:00Z',
  '2026-11-02T13:00:00Z',
  180, 120.00, 30.00,
  'online', 'KZB-TESTGB1'
) ON CONFLICT DO NOTHING;

-- ── Test platform admin account (S61) ───────────────────────────────────────
-- Email:    admin@kazione.internal
-- Password: Test1234!
-- Role:     is_platform_admin=true, no business_members row — CI's "Get test
-- admin token" step (ci.yml) authenticates as this user so admin-* edge
-- functions (requirePlatformAdmin) can be exercised by a real, hardcoded
-- fixture instead of an env-gated skip, per CLAUDE.md Rule 7.

DO $$
DECLARE
  v_user_id uuid := 'f0000000-0000-4000-8000-000000000003';
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = v_user_id) THEN
    RAISE NOTICE 'Seed platform admin already exists — skipping.';
    RETURN;
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role,
    email, encrypted_password,
    email_confirmed_at,
    confirmation_token, recovery_token,
    email_change, email_change_token_new, email_change_token_current,
    phone, phone_change, reauthentication_token,
    created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    is_sso_user, is_super_admin
  ) VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated', 'authenticated',
    'admin@kazione.internal',
    crypt('Test1234!', gen_salt('bf')),
    now(),
    '', '',
    '', '', '',
    NULL, '', '',
    now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{"first_name":"Platform","last_name":"Admin"}',
    false, false
  );

  INSERT INTO public.users (id, email, first_name, last_name, is_platform_admin)
  VALUES (v_user_id, 'admin@kazione.internal', 'Platform', 'Admin', true)
  ON CONFLICT (id) DO UPDATE SET is_platform_admin = true;

  RAISE NOTICE 'Seed platform admin account created: admin@kazione.internal / Test1234!';
END $$;

-- ── Test reviews (S61) ────────────────────────────────────────────────────────
-- Fixed-id completed appointments + reviews, one on the owner's own business
-- (b...001) and one on the foreign business (b...002, see "Foreign test
-- business" above), so review-moderation tests (owner-hide-own,
-- owner-hide-foreign→403, admin-hide-any, public-listing-excludes-hidden)
-- run against real hardcoded fixtures instead of skipping, per CLAUDE.md
-- Rule 7.

INSERT INTO appointments
  (id, business_id, client_id, staff_profile_id, service_id, status,
   starts_at, ends_at, duration_minutes, price, deposit_amount,
   booking_source, booking_reference)
VALUES (
  'f0000000-0000-4000-8000-000000000098',
  'b0000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000001',
  'completed',
  '2026-07-01T10:00:00Z',
  '2026-07-01T13:00:00Z',
  180, 120.00, 30.00,
  'online', 'KZB-REVIEWSEED1'
) ON CONFLICT DO NOTHING;

INSERT INTO reviews (id, business_id, client_id, appointment_id, rating, comment, reviewer_name, is_public)
VALUES (
  'e0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000098',
  4, 'Great service, will come back.', 'Test Reviewer', true
) ON CONFLICT DO NOTHING;

INSERT INTO appointments
  (id, business_id, client_id, status,
   starts_at, ends_at, duration_minutes, price, deposit_amount,
   booking_source, booking_reference)
VALUES (
  'f0000000-0000-4000-8000-000000000097',
  'b0000000-0000-4000-8000-000000000002',
  'c2000000-0000-4000-8000-000000000001',
  'completed',
  '2026-07-01T10:00:00Z',
  '2026-07-01T11:00:00Z',
  60, 50.00, 0.00,
  'online', 'KZB-REVIEWSEED2'
) ON CONFLICT DO NOTHING;

INSERT INTO reviews (id, business_id, client_id, appointment_id, rating, comment, reviewer_name, is_public)
VALUES (
  'e0000000-0000-4000-8000-000000000002',
  'b0000000-0000-4000-8000-000000000002',
  'c2000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000097',
  5, 'Foreign business test review.', 'Foreign Reviewer', true
) ON CONFLICT DO NOTHING;

-- ── Service with its own commission config + a confirmed appointment ───────
-- Fatima K. (d0000000-...001) has a personal commission_rate of 15% (see
-- migration 014_seed_data.sql), but this service defines its OWN 25%
-- commission — proving completion uses the service's config, not just the
-- staff's personal rate (the bug fixed alongside the commission-amount
-- prefill in the owner completion dialog).
INSERT INTO services (id, business_id, name, duration_minutes, price, currency_code,
                      is_active, is_public, staff_commission_type, staff_commission_value)
VALUES (
  'c0000000-0000-4000-8000-000000000007',
  'b0000000-0000-4000-8000-000000000001',
  'Commission Test Service', 60, 100.00, 'EUR', true, false,
  'percentage', 25.00
) ON CONFLICT DO NOTHING;

INSERT INTO appointments
  (id, business_id, client_id, staff_profile_id, service_id, status,
   starts_at, ends_at, duration_minutes, price, deposit_amount,
   booking_source, booking_reference)
VALUES (
  'f0000000-0000-4000-8000-000000000095',
  'b0000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001',
  'd0000000-0000-4000-8000-000000000001',
  'c0000000-0000-4000-8000-000000000007',
  'confirmed',
  '2026-12-01T10:00:00Z',
  '2026-12-01T11:00:00Z',
  60, 100.00, 0.00,
  'online', 'KZB-COMMTEST1'
) ON CONFLICT DO NOTHING;

-- ── Test platform_error_log row, unnotified (platform alerting) ────────────
-- Fixed id so platform-alert-digest.test.ts can assert THIS row transitions
-- notified_at: null → non-null after invoking the digest, without depending
-- on the table's total row count (which could include real rows from a
-- genuine bug elsewhere in the suite). No RLS INSERT policy exists on
-- platform_error_log for any non-service-role caller (writes only ever come
-- from withLogging via supabaseAdmin), so this has to be a direct seed
-- insert rather than something a test could create over the API.
INSERT INTO platform_error_log (id, function_name, method, status_code, message)
VALUES (
  'a0000000-0000-4000-8000-000000000001',
  'seed-test-fixture', 'GET', 500, 'Synthetic error for platform-alert-digest tests'
) ON CONFLICT DO NOTHING;
