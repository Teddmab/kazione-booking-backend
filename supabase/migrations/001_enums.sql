-- ─────────────────────────────────────────────────────────────────────────────
-- 001_enums.sql  –  Custom PostgreSQL types & reusable functions
-- KaziOne Booking
-- ─────────────────────────────────────────────────────────────────────────────

-- Required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ═══════════════════════════════════════════════════════════════════════════
-- ENUM TYPES  (wrapped in DO blocks for idempotency)
-- ═══════════════════════════════════════════════════════════════════════════

-- Business vertical
DO $$ BEGIN
  CREATE TYPE business_type AS ENUM (
    'hair_salon',
    'afro_salon',
    'nail_salon',
    'massage_studio',
    'esthetic_studio',
    'lash_brow_studio',
    'barbershop',
    'wellness'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Subscription plan tier
DO $$ BEGIN
  CREATE TYPE plan_type AS ENUM (
    'starter',
    'professional',
    'enterprise'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Subscription lifecycle
DO $$ BEGIN
  CREATE TYPE plan_status AS ENUM (
    'trial',
    'active',
    'suspended',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Role within a business (used by business_members)
DO $$ BEGIN
  CREATE TYPE member_role AS ENUM (
    'owner',
    'manager',
    'staff',
    'receptionist'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Tax regime
DO $$ BEGIN
  CREATE TYPE tax_type AS ENUM (
    'vat',
    'gst',
    'sales_tax',
    'none'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Appointment lifecycle
DO $$ BEGIN
  CREATE TYPE appointment_status AS ENUM (
    'pending',
    'confirmed',
    'in_progress',
    'completed',
    'cancelled',
    'no_show'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Where a booking originated
DO $$ BEGIN
  CREATE TYPE booking_source AS ENUM (
    'online',
    'walk_in',
    'phone',
    'staff',
    'receptionist',
    'marketplace'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Payment state
DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM (
    'pending',
    'paid',
    'refunded',
    'partial_refund',
    'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Payment method
DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM (
    'cash',
    'card',
    'online',
    'voucher',
    'bank_transfer'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Expense categories for P&L / bookkeeping
DO $$ BEGIN
  CREATE TYPE expense_category AS ENUM (
    'supplies',
    'rent',
    'utilities',
    'payroll',
    'marketing',
    'equipment',
    'software',
    'professional_services',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Supplier order states
DO $$ BEGIN
  CREATE TYPE supplier_order_status AS ENUM (
    'draft',
    'ordered',
    'received',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Entities that can have translated content
DO $$ BEGIN
  CREATE TYPE translatable_entity AS ENUM (
    'service',
    'service_category',
    'storefront'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- REUSABLE FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Auto-update updated_at on any row modification
-- Attach via:  CREATE TRIGGER … BEFORE UPDATE … FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- 2) On auth.users INSERT → mirror a row into public.users
-- Reads raw_user_meta_data for optional full_name & avatar_url.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, email, first_name, last_name, avatar_url)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'first_name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'last_name', ''),
    COALESCE(NEW.raw_user_meta_data ->> 'avatar_url', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Wire the trigger (idempotent: drop first)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();


-- 3) Return all business IDs the current JWT user belongs to.
-- Used by RLS policies:  business_id IN (SELECT get_my_business_ids())
-- NOTE: plpgsql used (not sql) so the body is not validated at creation time —
-- business_members is created in a later migration (002_core_tables.sql).
CREATE OR REPLACE FUNCTION get_my_business_ids()
RETURNS SETOF uuid AS $$
BEGIN
  RETURN QUERY
    SELECT business_id
    FROM public.business_members
    WHERE user_id = auth.uid();
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;


-- 4) Generate a unique booking reference in KZB-XXXXX format (base-36, upper).
-- Retries on the (astronomically unlikely) collision.
-- NOTE: appointments table is created in 006_appointment_tables.sql — safe because
-- plpgsql resolves table references at call time, not creation time.
CREATE OR REPLACE FUNCTION generate_booking_reference()
RETURNS text AS $$
DECLARE
  ref text;
  done bool := false;
BEGIN
  WHILE NOT done LOOP
    -- 5 random bytes → encode as hex → take first 5 chars → upper
    ref := 'KZB-' || upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 5));
    -- Check for collision against the appointments table
    done := NOT EXISTS (
      SELECT 1 FROM public.appointments WHERE booking_reference = ref
    );
  END LOOP;
  RETURN ref;
END;
$$ LANGUAGE plpgsql VOLATILE;
