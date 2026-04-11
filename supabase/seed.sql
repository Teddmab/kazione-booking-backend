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
