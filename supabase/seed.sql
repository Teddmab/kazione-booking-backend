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
