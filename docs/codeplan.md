# KaziOne Booking — Backend Implementation Code Plan
# Version: 1.0 | Date: April 2026
# Architecture: Supabase (Postgres + RLS + Edge Functions) + Frontend Service Layer
# ═══════════════════════════════════════════════════════════════════════════════

## ARCHITECTURE DECISION
────────────────────────────────────────────────────────────────────────────────
Backend = Supabase (primary runtime)
  ├── PostgreSQL           → data persistence, RLS, complex aggregations
  ├── Supabase Auth        → identity, sessions, magic link
  ├── Edge Functions       → business logic, Stripe, email, AI, exports
  ├── Supabase Storage     → images (gallery, logos, receipts, avatars)
  ├── Supabase Realtime    → live appointment board (receptionist)
  └── Postgres Functions   → report queries, availability engine, tax calcs

Frontend Service Layer (src/services/)
  ├── Typed Supabase client wrappers per domain
  ├── React Query hooks per resource
  └── Edge Function callers

NO separate Node.js/Express server at MVP.
Edge Functions handle all server-side business logic.
Postgres functions (RPC) handle all complex queries.
────────────────────────────────────────────────────────────────────────────────


## IMPLEMENTATION PHASES (execution order)
════════════════════════════════════════════════════════════════════════════════

PHASE 0 — Schema Foundation          (pre-requisite, run in Supabase SQL editor)
PHASE 1 — Booking Engine             (highest product value, unblocks everything)
PHASE 2 — Client & Staff Data        (owner dashboard goes live)
PHASE 3 — Finance & Reporting        (revenue module, tax prep)
PHASE 4 — Storefront & Marketplace   (public-facing)
PHASE 5 — Notifications & AI         (polish + intelligence layer)
PHASE 6 — Integrations               (Stripe, email, export)

════════════════════════════════════════════════════════════════════════════════


## PHASE 0 — COMPLETE DATABASE SCHEMA
════════════════════════════════════════════════════════════════════════════════
File: supabase/migrations/001_core_schema.sql
(Builds on previous schema.sql — adds all remaining tables)

### 0.1 Service Catalog Tables
────────────────────────────────────────────────────────────────────────────────

TABLE: service_categories
  id              uuid PK DEFAULT uuid_generate_v4()
  business_id     uuid FK → businesses.id (NULL = global/system category)
  name            text NOT NULL
  icon            text                        -- lucide icon name
  display_order   int NOT NULL DEFAULT 0
  created_at      timestamptz DEFAULT now()

TABLE: services
  id                  uuid PK DEFAULT uuid_generate_v4()
  business_id         uuid NOT NULL FK → businesses.id
  category_id         uuid FK → service_categories.id
  name                text NOT NULL
  description         text
  duration_minutes    int NOT NULL
  price               numeric(10,2) NOT NULL
  currency_code       text NOT NULL DEFAULT 'EUR'
  deposit_amount      numeric(10,2)             -- NULL = use business_settings default
  is_active           boolean NOT NULL DEFAULT true
  is_public           boolean NOT NULL DEFAULT true
  image_url           text
  display_order       int NOT NULL DEFAULT 0
  created_at          timestamptz DEFAULT now()
  updated_at          timestamptz DEFAULT now()

TABLE: service_translations
  id            uuid PK DEFAULT uuid_generate_v4()
  service_id    uuid NOT NULL FK → services.id ON DELETE CASCADE
  locale        text NOT NULL                  -- 'en', 'et', 'fr'
  field         text NOT NULL                  -- 'name', 'description'
  value         text NOT NULL
  updated_at    timestamptz DEFAULT now()
  UNIQUE(service_id, locale, field)

### 0.2 Staff Tables
────────────────────────────────────────────────────────────────────────────────

TABLE: staff_profiles
  id                  uuid PK DEFAULT uuid_generate_v4()
  business_id         uuid NOT NULL FK → businesses.id
  business_member_id  uuid FK → business_members.id
  display_name        text NOT NULL
  bio                 text
  avatar_url          text
  specialties         text[] DEFAULT '{}'
  commission_rate     numeric(5,2) DEFAULT 0    -- percentage
  calendar_color      text DEFAULT '#8B5CF6'
  is_active           boolean NOT NULL DEFAULT true
  created_at          timestamptz DEFAULT now()
  updated_at          timestamptz DEFAULT now()

TABLE: staff_services (many-to-many: which staff can do which services)
  id                      uuid PK DEFAULT uuid_generate_v4()
  staff_profile_id        uuid NOT NULL FK → staff_profiles.id ON DELETE CASCADE
  service_id              uuid NOT NULL FK → services.id ON DELETE CASCADE
  custom_duration_minutes int             -- NULL = use service default
  custom_price            numeric(10,2)  -- NULL = use service default
  UNIQUE(staff_profile_id, service_id)

TABLE: staff_working_hours
  id                  uuid PK DEFAULT uuid_generate_v4()
  staff_profile_id    uuid NOT NULL FK → staff_profiles.id ON DELETE CASCADE
  business_id         uuid NOT NULL FK → businesses.id
  day_of_week         int NOT NULL    -- 0=Sun, 1=Mon, ..., 6=Sat
  start_time          time NOT NULL
  end_time            time NOT NULL
  is_working          boolean NOT NULL DEFAULT true
  UNIQUE(staff_profile_id, day_of_week)

TABLE: staff_time_off
  id                  uuid PK DEFAULT uuid_generate_v4()
  staff_profile_id    uuid NOT NULL FK → staff_profiles.id ON DELETE CASCADE
  business_id         uuid NOT NULL FK → businesses.id
  starts_at           timestamptz NOT NULL
  ends_at             timestamptz NOT NULL
  reason              text
  created_at          timestamptz DEFAULT now()

### 0.3 Client Tables
────────────────────────────────────────────────────────────────────────────────

TABLE: clients
  id                    uuid PK DEFAULT uuid_generate_v4()
  business_id           uuid NOT NULL FK → businesses.id
  user_id               uuid FK → users.id (NULL for guest clients)
  first_name            text NOT NULL
  last_name             text NOT NULL
  email                 text
  phone                 text
  avatar_url            text
  date_of_birth         date
  notes                 text
  tags                  text[] DEFAULT '{}'
  preferred_staff_id    uuid FK → staff_profiles.id
  preferred_locale      text DEFAULT 'en'
  gdpr_consent          boolean NOT NULL DEFAULT false
  gdpr_consent_at       timestamptz
  marketing_opt_in      boolean NOT NULL DEFAULT false
  source                text DEFAULT 'manual' -- 'manual','import','marketplace','walk_in'
  created_at            timestamptz DEFAULT now()
  updated_at            timestamptz DEFAULT now()

  INDEX: (business_id, email)
  INDEX: (business_id, user_id)
  UNIQUE: (business_id, email) WHERE email IS NOT NULL

### 0.4 Appointment Tables
────────────────────────────────────────────────────────────────────────────────

TABLE: appointments
  id                  uuid PK DEFAULT uuid_generate_v4()
  business_id         uuid NOT NULL FK → businesses.id
  client_id           uuid FK → clients.id
  staff_profile_id    uuid FK → staff_profiles.id
  service_id          uuid FK → services.id     -- primary service
  status              appointment_status NOT NULL DEFAULT 'pending'
  starts_at           timestamptz NOT NULL
  ends_at             timestamptz NOT NULL
  duration_minutes    int NOT NULL
  price               numeric(10,2) NOT NULL
  deposit_amount      numeric(10,2) DEFAULT 0
  booking_source      booking_source NOT NULL DEFAULT 'online'
  booking_reference   text UNIQUE NOT NULL      -- e.g. 'KZB-7FA3X'
  is_walk_in          boolean NOT NULL DEFAULT false
  notes               text
  internal_notes      text                      -- staff-only notes
  cancellation_reason text
  cancelled_at        timestamptz
  cancelled_by        uuid FK → users.id
  reminder_sent_at    timestamptz
  no_show_marked_at   timestamptz
  created_at          timestamptz DEFAULT now()
  updated_at          timestamptz DEFAULT now()

  INDEX: (business_id, starts_at)
  INDEX: (business_id, client_id)
  INDEX: (business_id, staff_profile_id)
  INDEX: (business_id, status)
  INDEX: booking_reference (UNIQUE)

TABLE: appointment_services (line items for multi-service bookings)
  id                  uuid PK DEFAULT uuid_generate_v4()
  appointment_id      uuid NOT NULL FK → appointments.id ON DELETE CASCADE
  service_id          uuid NOT NULL FK → services.id
  staff_profile_id    uuid FK → staff_profiles.id
  price               numeric(10,2) NOT NULL
  duration_minutes    int NOT NULL
  starts_at           timestamptz
  ends_at             timestamptz

TABLE: appointment_status_log (audit trail)
  id              uuid PK DEFAULT uuid_generate_v4()
  appointment_id  uuid NOT NULL FK → appointments.id ON DELETE CASCADE
  old_status      appointment_status
  new_status      appointment_status NOT NULL
  changed_by      uuid FK → users.id
  reason          text
  created_at      timestamptz DEFAULT now()

### 0.5 Payment Tables
────────────────────────────────────────────────────────────────────────────────

TABLE: payments
  id                          uuid PK DEFAULT uuid_generate_v4()
  business_id                 uuid NOT NULL FK → businesses.id
  appointment_id              uuid NOT NULL FK → appointments.id
  client_id                   uuid FK → clients.id
  amount                      numeric(10,2) NOT NULL
  currency_code               text NOT NULL DEFAULT 'EUR'
  tip_amount                  numeric(10,2) DEFAULT 0
  discount_amount             numeric(10,2) DEFAULT 0
  discount_code               text
  tax_amount                  numeric(10,2) DEFAULT 0
  tax_rate                    numeric(5,2) DEFAULT 0
  status                      payment_status NOT NULL DEFAULT 'pending'
  method                      payment_method NOT NULL DEFAULT 'card'
  stripe_payment_intent_id    text UNIQUE
  stripe_charge_id            text
  stripe_refund_id            text
  paid_at                     timestamptz
  refunded_at                 timestamptz
  refund_amount               numeric(10,2) DEFAULT 0
  notes                       text
  receipt_url                 text
  created_at                  timestamptz DEFAULT now()
  updated_at                  timestamptz DEFAULT now()

  INDEX: (business_id, appointment_id)
  INDEX: (business_id, status)
  INDEX: (business_id, paid_at)

### 0.6 Finance Tables
────────────────────────────────────────────────────────────────────────────────

TABLE: suppliers
  id              uuid PK DEFAULT uuid_generate_v4()
  business_id     uuid NOT NULL FK → businesses.id
  name            text NOT NULL
  contact_name    text
  email           text
  phone           text
  website         text
  address         text
  notes           text
  is_active       boolean NOT NULL DEFAULT true
  created_at      timestamptz DEFAULT now()
  updated_at      timestamptz DEFAULT now()

TABLE: expenses
  id                  uuid PK DEFAULT uuid_generate_v4()
  business_id         uuid NOT NULL FK → businesses.id
  supplier_id         uuid FK → suppliers.id
  category            expense_category NOT NULL DEFAULT 'other'
  description         text NOT NULL
  amount              numeric(10,2) NOT NULL
  currency_code       text NOT NULL DEFAULT 'EUR'
  tax_amount          numeric(10,2) DEFAULT 0
  tax_rate            numeric(5,2) DEFAULT 0
  receipt_url         text
  date                date NOT NULL
  is_recurring        boolean NOT NULL DEFAULT false
  recurrence_rule     jsonb    -- { "frequency": "monthly", "day": 1 }
  recurrence_end_date date
  notes               text
  created_by          uuid FK → users.id
  created_at          timestamptz DEFAULT now()
  updated_at          timestamptz DEFAULT now()

  INDEX: (business_id, date)
  INDEX: (business_id, category)
  INDEX: (business_id, supplier_id)

TABLE: supplier_orders
  id              uuid PK DEFAULT uuid_generate_v4()
  business_id     uuid NOT NULL FK → businesses.id
  supplier_id     uuid NOT NULL FK → suppliers.id
  reference       text
  status          supplier_order_status NOT NULL DEFAULT 'draft'
  total_amount    numeric(10,2) NOT NULL DEFAULT 0
  notes           text
  ordered_at      timestamptz
  expected_at     timestamptz
  received_at     timestamptz
  created_by      uuid FK → users.id
  created_at      timestamptz DEFAULT now()
  updated_at      timestamptz DEFAULT now()

TABLE: supplier_order_items
  id              uuid PK DEFAULT uuid_generate_v4()
  order_id        uuid NOT NULL FK → supplier_orders.id ON DELETE CASCADE
  product_name    text NOT NULL
  sku             text
  quantity        int NOT NULL DEFAULT 1
  unit_price      numeric(10,2) NOT NULL
  total_price     numeric(10,2) NOT NULL    -- quantity × unit_price

### 0.7 Storefront & Marketplace Tables
────────────────────────────────────────────────────────────────────────────────

TABLE: storefronts
  id                  uuid PK DEFAULT uuid_generate_v4()
  business_id         uuid NOT NULL UNIQUE FK → businesses.id
  slug                text NOT NULL UNIQUE
  title               text NOT NULL
  tagline             text
  description         text
  extended_description text
  logo_url            text
  cover_image_url     text
  accent_color        text DEFAULT '#C9873E'
  is_published        boolean NOT NULL DEFAULT false
  custom_domain       text UNIQUE
  -- Contact
  address             text
  city                text
  country_code        text
  phone               text
  email               text
  website             text
  -- Marketplace listing
  marketplace_status  text DEFAULT 'draft'   -- 'draft','active','hidden'
  marketplace_featured boolean DEFAULT false
  marketplace_headline text
  marketplace_tags    text[] DEFAULT '{}'
  marketplace_categories text[] DEFAULT '{}'
  -- Policies
  booking_policy      text
  cancellation_policy text
  -- Section visibility (jsonb for flexibility)
  sections            jsonb NOT NULL DEFAULT '{
    "hero": true, "about": true, "services": true,
    "promotions": true, "gallery": true, "team": true,
    "reviews": false, "booking": true
  }'
  -- SEO
  seo_title           text
  seo_description     text
  created_at          timestamptz DEFAULT now()
  updated_at          timestamptz DEFAULT now()

TABLE: storefront_gallery
  id              uuid PK DEFAULT uuid_generate_v4()
  storefront_id   uuid NOT NULL FK → storefronts.id ON DELETE CASCADE
  image_url       text NOT NULL
  caption         text
  display_order   int NOT NULL DEFAULT 0
  created_at      timestamptz DEFAULT now()

TABLE: promotions
  id              uuid PK DEFAULT uuid_generate_v4()
  business_id     uuid NOT NULL FK → businesses.id
  title           text NOT NULL
  description     text
  discount_type   text NOT NULL DEFAULT 'percentage' -- 'percentage', 'fixed'
  discount_value  numeric(10,2) NOT NULL
  badge           text
  valid_from      date
  valid_until     date
  is_active       boolean NOT NULL DEFAULT true
  applies_to      uuid[] DEFAULT '{}'  -- service_ids, empty = all services
  created_at      timestamptz DEFAULT now()

TABLE: reviews
  id              uuid PK DEFAULT uuid_generate_v4()
  business_id     uuid NOT NULL FK → businesses.id
  client_id       uuid FK → clients.id
  appointment_id  uuid UNIQUE FK → appointments.id
  rating          int NOT NULL CHECK (rating BETWEEN 1 AND 5)
  comment         text
  is_public       boolean NOT NULL DEFAULT true
  owner_reply     text
  replied_at      timestamptz
  created_at      timestamptz DEFAULT now()

  INDEX: (business_id, is_public)

### 0.8 Notification & Translation Tables
────────────────────────────────────────────────────────────────────────────────

TABLE: notifications
  id              uuid PK DEFAULT uuid_generate_v4()
  business_id     uuid FK → businesses.id
  user_id         uuid FK → users.id
  type            text NOT NULL  -- 'appointment_confirmed','reminder','payment','review_request'
  title           text NOT NULL
  body            text NOT NULL
  metadata        jsonb DEFAULT '{}'
  is_read         boolean NOT NULL DEFAULT false
  created_at      timestamptz DEFAULT now()

  INDEX: (user_id, is_read)

TABLE: translations
  id              uuid PK DEFAULT uuid_generate_v4()
  business_id     uuid FK → businesses.id
  entity_type     translatable_entity NOT NULL
  entity_id       uuid NOT NULL
  locale          text NOT NULL
  field           text NOT NULL
  value           text NOT NULL
  updated_at      timestamptz DEFAULT now()
  UNIQUE(entity_type, entity_id, locale, field)

  INDEX: (entity_type, entity_id, locale)

TABLE: guest_sessions
  id              uuid PK DEFAULT uuid_generate_v4()
  email           text NOT NULL
  token           text NOT NULL UNIQUE    -- short-lived lookup token
  expires_at      timestamptz NOT NULL
  created_at      timestamptz DEFAULT now()

  INDEX: (email, token)


## PHASE 0 — POSTGRES FUNCTIONS (RPC layer)
════════════════════════════════════════════════════════════════════════════════
File: supabase/migrations/002_postgres_functions.sql

### 0.A Availability Engine
────────────────────────────────────────────────────────────────────────────────

FUNCTION: get_available_slots(
  p_business_id     uuid,
  p_service_id      uuid,
  p_staff_id        uuid,  -- NULL = any staff
  p_date            date
) RETURNS TABLE (slot_time time, staff_profile_id uuid, staff_name text)

Logic:
  1. Get service duration_minutes
  2. Get all staff that can do this service (from staff_services)
  3. For each staff: get working hours for p_date's day_of_week
  4. Generate time slots (every 30 min within working hours)
  5. Filter out slots already booked (appointments table, status NOT IN cancelled/no_show)
  6. Filter out time_off periods
  7. Return available slots with staff info

FUNCTION: get_business_calendar(
  p_business_id     uuid,
  p_start_date      date,
  p_end_date        date,
  p_staff_id        uuid  -- NULL = all staff
) RETURNS TABLE (appointment data with joins)

### 0.B Finance Aggregation Functions
────────────────────────────────────────────────────────────────────────────────

FUNCTION: get_revenue_summary(
  p_business_id   uuid,
  p_start_date    date,
  p_end_date      date
) RETURNS jsonb
  -- Returns: total_income, total_expenses, profit, by_service[], by_staff[]

FUNCTION: get_income_breakdown(
  p_business_id   uuid,
  p_start_date    date,
  p_end_date      date,
  p_group_by      text  -- 'day', 'week', 'month'
) RETURNS TABLE (period text, amount numeric, count int)

FUNCTION: get_expense_breakdown(
  p_business_id   uuid,
  p_start_date    date,
  p_end_date      date
) RETURNS TABLE (category expense_category, amount numeric, count int)

FUNCTION: get_tax_summary(
  p_business_id   uuid,
  p_year          int,
  p_quarter       int  -- NULL = full year
) RETURNS jsonb
  -- Returns: gross_income, tax_collected, net_income, by_period[]

FUNCTION: get_staff_performance(
  p_business_id   uuid,
  p_start_date    date,
  p_end_date      date
) RETURNS TABLE (
  staff_profile_id uuid, display_name text, bookings int,
  revenue numeric, clients int, avg_rating numeric, completion_rate numeric
)

### 0.C Reference Generator
────────────────────────────────────────────────────────────────────────────────

FUNCTION: generate_booking_reference() RETURNS text
  -- Generates 'KZB-XXXXX' unique reference
  -- Algorithm: 'KZB-' + 5 random base-36 chars, retry on collision

### 0.D Dashboard KPI Function
────────────────────────────────────────────────────────────────────────────────

FUNCTION: get_owner_dashboard_kpis(
  p_business_id   uuid,
  p_date          date   -- defaults to today
) RETURNS jsonb
  -- Returns single JSON with: today_appointments, revenue_today, revenue_month,
  --   new_clients_month, active_clients, avg_rating, completion_rate,
  --   top_services[], busy_hours[], upcoming_appointments[]


## PHASE 0 — RLS POLICIES (all new tables)
════════════════════════════════════════════════════════════════════════════════
File: supabase/migrations/003_rls_policies.sql

Pattern for all tenant-owned tables:
  SELECT: business_id IN (SELECT get_my_business_ids())
  INSERT: auth.role() = 'authenticated' AND business_id IN (SELECT get_my_business_ids())
  UPDATE: business_id IN (SELECT get_my_business_ids()) AND role check where needed
  DELETE: owners/managers only

Special cases:
  storefronts:  SELECT also allowed when is_published = true (for public marketplace)
  reviews:      SELECT allowed when is_public = true (for public storefront)
  appointments: clients can SELECT their own (WHERE client_id matches user's client record)
  guest_sessions: no auth required for INSERT/SELECT (token-based)
  service_translations: readable by anyone (needed for public storefront)


## PHASE 0 — SUPABASE STORAGE BUCKETS
════════════════════════════════════════════════════════════════════════════════
Via Supabase Dashboard → Storage (or via MCP)

Buckets:
  business-assets/    (public)
    └── {business_id}/logo.{ext}
    └── {business_id}/cover.{ext}
    └── {business_id}/gallery/{id}.{ext}
    └── {business_id}/staff/{staff_id}/avatar.{ext}
    └── {business_id}/services/{service_id}/image.{ext}

  receipts/           (private — owner only)
    └── {business_id}/expenses/{expense_id}/receipt.{ext}

  reports/            (private — owner only)
    └── {business_id}/exports/{year}/{filename}.{ext}

Policies:
  business-assets: public READ, authenticated WRITE where path starts with user's business_id
  receipts: authenticated READ/WRITE where path starts with user's business_id
  reports: same as receipts


## PHASE 1 — BOOKING ENGINE EDGE FUNCTIONS
════════════════════════════════════════════════════════════════════════════════
Directory: supabase/functions/

### 1.1 GET public business data (for booking wizard)
────────────────────────────────────────────────────────────────────────────────
File: supabase/functions/get-storefront/index.ts

Route: GET /functions/v1/get-storefront?slug={slug}
Auth: None (public endpoint)

Logic:
  1. Query storefronts WHERE slug = $slug AND is_published = true
  2. JOIN businesses for basic info
  3. JOIN services WHERE is_active = true AND is_public = true
  4. JOIN staff_profiles WHERE is_active = true with their staff_services
  5. JOIN promotions WHERE is_active = true AND valid date range
  6. JOIN reviews WHERE is_public = true, aggregate rating
  7. JOIN storefront_gallery ORDER BY display_order
  8. Apply locale from Accept-Language header for service_translations
  9. Return shaped response matching StorefrontData interface

Response matches src/data/storefrontData.ts::StorefrontData shape exactly
so frontend can swap the import with this API call.

### 1.2 GET available time slots
────────────────────────────────────────────────────────────────────────────────
File: supabase/functions/get-availability/index.ts

Route: GET /functions/v1/get-availability
Params: business_id, service_id, date (YYYY-MM-DD), staff_id (optional)
Auth: None (public)

Logic:
  1. Call get_available_slots() Postgres function
  2. Group slots by staff member
  3. Apply business_settings.booking_lead_time_hours (no slots in the past + lead time)
  4. Apply business_settings.booking_future_days (no slots beyond this)
  5. Return { date, slots: [{ time, available_staff: [...] }] }

### 1.3 POST create booking (THE most critical function)
────────────────────────────────────────────────────────────────────────────────
File: supabase/functions/create-booking/index.ts

Route: POST /functions/v1/create-booking
Auth: Optional (both authenticated users and guests)

Request body:
  {
    business_id: string,
    service_id: string,
    staff_profile_id: string | null,
    date: string,
    time: string,
    client: {
      name: string,
      email: string,
      phone: string,
      notes: string,
      is_guest: boolean
    },
    payment_method: 'deposit' | 'full' | 'later',
    locale: string
  }

Logic:
  1. VALIDATE: check slot is still available (atomic — use Postgres transaction)
  2. RESOLVE CLIENT:
     a. If authenticated user → find or create client record linked to user
     b. If guest → find existing client by email+business_id or create new
  3. CALCULATE PRICING:
     a. Get service price
     b. Apply any active promotions
     c. Calculate deposit (from business_settings or service override)
     d. Calculate tax (from business_settings)
  4. CREATE APPOINTMENT:
     - INSERT into appointments with 'pending' status
     - Generate booking_reference via generate_booking_reference()
     - INSERT appointment_services row
  5. HANDLE PAYMENT:
     a. If 'later' → skip Stripe, mark payment as 'pending'
     b. If 'deposit' or 'full' → create Stripe PaymentIntent
        - Return client_secret to frontend for Stripe Elements
        - Payment confirmation happens in stripe-webhook function
     c. Insert payments row with status 'pending'
  6. IF NO PAYMENT → confirm appointment immediately:
     - UPDATE appointment.status = 'confirmed'
     - INSERT appointment_status_log
  7. SEND CONFIRMATION EMAIL (call send-email Edge Function)
  8. TRIGGER NOTIFICATION for business owner/receptionist
  9. RETURN: { booking_reference, appointment_id, payment_intent_client_secret? }

Error handling:
  - Slot taken (race condition): return 409 with available alternatives
  - Payment failed: appointment stays 'pending', return error
  - Invalid service/staff combo: 400

### 1.4 POST Stripe Webhook Handler
────────────────────────────────────────────────────────────────────────────────
File: supabase/functions/stripe-webhook/index.ts

Route: POST /functions/v1/stripe-webhook
Auth: Stripe signature verification (STRIPE_WEBHOOK_SECRET env var)

Events handled:
  payment_intent.succeeded:
    → UPDATE payments SET status='paid', paid_at=now()
    → UPDATE appointments SET status='confirmed'
    → INSERT appointment_status_log
    → Call send-confirmation-email
    → INSERT notification for business

  payment_intent.payment_failed:
    → UPDATE payments SET status='failed'
    → Keep appointment as 'pending' for 15 min, then auto-cancel
    → Notify client

  payment_intent.refunded:
    → UPDATE payments SET status='refunded', refunded_at=now()
    → UPDATE appointments SET status='cancelled'

### 1.5 POST cancel-booking
────────────────────────────────────────────────────────────────────────────────
File: supabase/functions/cancel-booking/index.ts

Route: POST /functions/v1/cancel-booking
Auth: Required (or guest token)

Logic:
  1. Verify caller owns this booking (or is business member)
  2. Check cancellation policy (business_settings.cancellation_hours)
  3. Determine refund eligibility:
     - If > cancellation_hours before: full refund
     - If deposit paid and within window: deposit forfeited
  4. If refund eligible: create Stripe refund
  5. UPDATE appointment status='cancelled', set cancellation_reason
  6. UPDATE payments SET status='refunded' / 'partial_refund'
  7. Send cancellation email
  8. Return result

### 1.6 POST reschedule-booking
────────────────────────────────────────────────────────────────────────────────
File: supabase/functions/reschedule-booking/index.ts

Route: POST /functions/v1/reschedule-booking
Auth: Required (or guest token)

Request body: { appointment_id, new_date, new_time, staff_profile_id? }

Logic:
  1. Validate new slot is available
  2. Check business reschedule policy
  3. UPDATE appointments starts_at, ends_at, staff_profile_id
  4. INSERT appointment_status_log
  5. Send reschedule confirmation email
  6. Return updated appointment

### 1.7 GET bookings by reference (guest lookup)
────────────────────────────────────────────────────────────────────────────────
File: supabase/functions/lookup-booking/index.ts

Route: GET /functions/v1/lookup-booking?email={email}&reference={ref}
Auth: None (uses email+reference as authentication)

Logic:
  1. Find appointment WHERE booking_reference = $ref
  2. Verify client.email matches (case-insensitive)
  3. Return full booking detail (same shape as CustomerBooking interface)
  4. Never expose internal_notes to guests


## PHASE 1 — FRONTEND SERVICE LAYER (booking)
════════════════════════════════════════════════════════════════════════════════
Directory: src/services/

### src/services/bookingService.ts
────────────────────────────────────────────────────────────────────────────────
export async function getStorefront(slug: string): Promise<StorefrontData>
  → Replaces getStorefrontBySlug() from storefrontData.ts
  → Calls get-storefront Edge Function
  → Transforms response to StorefrontData shape

export async function getAvailability(params: AvailabilityParams): Promise<AvailabilityResult>
  → Calls get-availability Edge Function

export async function createBooking(params: CreateBookingParams): Promise<CreateBookingResult>
  → Calls create-booking Edge Function
  → Returns { reference, appointmentId, paymentIntentClientSecret? }

export async function cancelBooking(params: CancelBookingParams): Promise<void>
  → Calls cancel-booking Edge Function

export async function rescheduleBooking(params: RescheduleParams): Promise<void>
  → Calls reschedule-booking Edge Function

export async function lookupBookingByReference(email: string, reference: string): Promise<CustomerBooking>
  → Calls lookup-booking Edge Function

### src/services/appointmentService.ts
────────────────────────────────────────────────────────────────────────────────
(For owner/receptionist dashboard — authenticated, uses Supabase client directly)

export async function getAppointments(businessId: string, filters: AppointmentFilters)
  → Supabase query on appointments with joins
  → Supports: date range, status filter, staff filter, search

export async function getAppointment(id: string): Promise<AppointmentDetail>
  → Single appointment with full joins

export async function createAppointment(data: CreateAppointmentData): Promise<Appointment>
  → For owner/receptionist creating appointments manually

export async function updateAppointmentStatus(id: string, status: AppointmentStatus, reason?: string)
  → UPDATE + INSERT status log

export async function getDashboardKPIs(businessId: string): Promise<DashboardKPIs>
  → Calls get_owner_dashboard_kpis() Postgres function via RPC


## PHASE 1 — REACT QUERY HOOKS (booking)
════════════════════════════════════════════════════════════════════════════════
Directory: src/hooks/

### src/hooks/useStorefront.ts
  useStorefront(slug: string) → useQuery → bookingService.getStorefront()
  Replaces direct storefrontData.ts import in SalonStorefront, SalonServices, SalonBooking

### src/hooks/useAvailability.ts
  useAvailability(params) → useQuery with enabled: !!date && !!serviceId
  Replaces static timeSlots array in SalonBooking.tsx

### src/hooks/useCreateBooking.ts
  useCreateBooking() → useMutation → bookingService.createBooking()
  Handles Stripe Elements integration

### src/hooks/useAppointments.ts
  useAppointments(filters) → useQuery → appointmentService.getAppointments()
  useAppointment(id) → useQuery
  useUpdateAppointmentStatus() → useMutation
  useDashboardKPIs() → useQuery → Postgres RPC

### src/hooks/useCustomerBookings.ts
  useCustomerBookings(userId) → useQuery → client's own bookings
  useLookupBooking(email, ref) → useQuery → guest booking lookup


## PHASE 2 — CLIENT & STAFF DATA
════════════════════════════════════════════════════════════════════════════════

### src/services/clientService.ts
────────────────────────────────────────────────────────────────────────────────
export async function getClients(businessId, filters: ClientFilters)
  → Supabase query: clients + count of appointments + last visit date
  → Supports: search (name/email/phone), tag filter, date range

export async function getClient(id: string): Promise<ClientDetail>
  → Client + appointments history + payment history + notes

export async function createClient(businessId, data: CreateClientData)
  → INSERT into clients
  → Check for duplicate email (conflict resolution)

export async function updateClient(id, data: UpdateClientData)

export async function importClients(businessId, clients: ImportClientRow[])
  → Batch INSERT with conflict handling (upsert on email)
  → Returns: { imported, skipped, errors }

export async function getClientStats(businessId, clientId)
  → Total spent, visit count, favorite services, LTV estimate

### src/services/staffService.ts
────────────────────────────────────────────────────────────────────────────────
export async function getStaffProfiles(businessId): Promise<StaffProfile[]>
  → staff_profiles + business_members + staff_services + working_hours

export async function getStaffProfile(id): Promise<StaffProfileDetail>
  → Full profile + performance data + upcoming appointments

export async function inviteStaffMember(businessId, data: InviteStaffData)
  → Edge Function: supabase/functions/invite-staff/index.ts
  → Creates business_member with role
  → Sends invitation email with Supabase magic link

export async function updateStaffProfile(id, data)

export async function updateWorkingHours(staffId, hours: WorkingHours[])
  → Upsert into staff_working_hours

export async function getStaffPerformance(businessId, period)
  → Calls get_staff_performance() Postgres function

### src/hooks/useClients.ts
  useClients(filters) → useQuery
  useClient(id) → useQuery
  useCreateClient() → useMutation
  useUpdateClient() → useMutation
  useImportClients() → useMutation

### src/hooks/useStaff.ts
  useStaffProfiles() → useQuery
  useStaffProfile(id) → useQuery
  useInviteStaff() → useMutation
  useUpdateWorkingHours() → useMutation
  useStaffPerformance(period) → useQuery → Postgres RPC


## PHASE 3 — FINANCE & REPORTING
════════════════════════════════════════════════════════════════════════════════

### src/services/financeService.ts
────────────────────────────────────────────────────────────────────────────────
export async function getRevenueSummary(businessId, dateRange): Promise<RevenueSummary>
  → Calls get_revenue_summary() Postgres RPC

export async function getIncomeBreakdown(businessId, dateRange, groupBy)
  → Calls get_income_breakdown() Postgres RPC
  → Powers IncomeTracking.tsx charts

export async function getExpenses(businessId, filters): Promise<Expense[]>
  → Supabase query with filters (category, date range, supplier)

export async function createExpense(businessId, data: CreateExpenseData)
  → INSERT into expenses
  → If receipt file: upload to Storage first, then save URL

export async function updateExpense(id, data)

export async function deleteExpense(id)

export async function getExpenseBreakdown(businessId, dateRange)
  → Calls get_expense_breakdown() Postgres RPC

export async function getTaxSummary(businessId, year, quarter?)
  → Calls get_tax_summary() Postgres RPC
  → Returns VAT collected, estimated tax liability

export async function getBookkeepingTransactions(businessId, dateRange)
  → Combined view: payments (income) + expenses (costs)
  → Sorted by date, categorized, with running balance

### supabase/functions/export-report/index.ts
────────────────────────────────────────────────────────────────────────────────
Route: POST /functions/v1/export-report
Auth: Required (owner/manager only)

Body: { business_id, report_type, date_range, format: 'csv' | 'json' }

Report types:
  'accountant'     → Full transaction list, categorized, with tax breakdown
  'income'         → Payment records with service/client details
  'expenses'       → Expense records with supplier details
  'tax_summary'    → VAT/tax period summary
  'staff_payroll'  → Commission calculations per staff

Logic:
  1. Run appropriate Postgres aggregation
  2. Format as CSV
  3. Upload to reports/ Storage bucket
  4. Return signed URL (valid 1 hour)

### src/hooks/useFinance.ts
  useRevenueSummary(dateRange) → useQuery → Postgres RPC
  useIncomeBreakdown(dateRange, groupBy) → useQuery
  useExpenses(filters) → useQuery
  useCreateExpense() → useMutation
  useExpenseBreakdown(dateRange) → useQuery
  useTaxSummary(year, quarter) → useQuery
  useBookkeepingTransactions(dateRange) → useQuery
  useExportReport() → useMutation → Edge Function

### src/hooks/useReports.ts
  useStaffPerformanceReport(dateRange) → useQuery → Postgres RPC
  useClientRetentionReport(dateRange) → useQuery
  useServicePopularityReport(dateRange) → useQuery
  useRevenueReport(dateRange, groupBy) → useQuery


## PHASE 4 — STOREFRONT & MARKETPLACE
════════════════════════════════════════════════════════════════════════════════

### src/services/storefrontService.ts
────────────────────────────────────────────────────────────────────────────────
export async function getStorefront(businessId): Promise<Storefront>
  → Owner-side: full storefront data for editor (no public filter)

export async function updateStorefront(businessId, data: UpdateStorefrontData)
  → UPSERT storefronts table

export async function uploadGalleryImage(businessId, file: File): Promise<string>
  → Upload to business-assets/{business_id}/gallery/{id}.jpg
  → INSERT storefront_gallery row
  → Return image URL

export async function deleteGalleryImage(galleryId: string)
  → DELETE from storefront_gallery
  → Remove from Storage

export async function updateSectionVisibility(businessId, sections)
  → UPDATE storefronts.sections

export async function publishStorefront(businessId)
  → UPDATE storefronts SET is_published = true, marketplace_status = 'active'

export async function getPublicMarketplace(filters: MarketplaceFilters)
  → Query public storefronts with rating aggregation
  → Filters: category, location/city, search, featured

### src/services/reviewService.ts
────────────────────────────────────────────────────────────────────────────────
export async function getBusinessReviews(businessId): Promise<Review[]>
  → Paginated, sorted by created_at DESC

export async function submitReview(data: SubmitReviewData)
  → INSERT into reviews
  → Verify appointment is completed and belongs to this client

export async function replyToReview(reviewId, reply: string)
  → UPDATE reviews SET owner_reply, replied_at

### src/hooks/useStorefront.ts (owner-side version)
  useOwnerStorefront() → useQuery → storefrontService.getStorefront()
  useUpdateStorefront() → useMutation
  useUploadGalleryImage() → useMutation → Storage upload
  usePublishStorefront() → useMutation

### src/hooks/useMarketplace.ts
  useMarketplaceSalons(filters) → useQuery → public query
  useReviews(businessId) → useQuery
  useSubmitReview() → useMutation


## PHASE 5 — NOTIFICATIONS & AI INSIGHTS
════════════════════════════════════════════════════════════════════════════════

### supabase/functions/send-email/index.ts
────────────────────────────────────────────────────────────────────────────────
Route: POST /functions/v1/send-email (internal, called by other functions)
Provider: Resend (resend.com) — EU data processing

Templates (hardcoded in function, locale-aware):
  booking_confirmation  → booking reference, details, add-to-calendar link
  booking_reminder      → 24h before appointment (called by cron)
  booking_cancellation  → with refund details if applicable
  booking_reschedule    → new date/time confirmation
  staff_invite          → invitation with Supabase magic link
  review_request        → 2h after appointment completes

Env vars: RESEND_API_KEY, APP_URL, BUSINESS_EMAIL_FROM

### supabase/functions/send-reminders/index.ts (CRON)
────────────────────────────────────────────────────────────────────────────────
Triggered: Every hour via Supabase cron (pg_cron)
Schedule: '0 * * * *'

Logic:
  1. Find appointments WHERE starts_at IS within next 24 hours
     AND status = 'confirmed'
     AND reminder_sent_at IS NULL
     AND businesses.settings.reminder_email_enabled = true
  2. For each: call send-email with booking_confirmation template
  3. UPDATE appointments.reminder_sent_at = now()

### supabase/functions/ai-insights/index.ts
────────────────────────────────────────────────────────────────────────────────
Route: POST /functions/v1/ai-insights
Auth: Required (owner/manager)

Body: { business_id, question?, period }

Logic:
  1. Gather context data (last 30 days):
     - get_revenue_summary()
     - get_staff_performance()
     - Appointment completion rate, no-show rate
     - Top/bottom performing services
     - Client retention metrics
  2. Build a structured context prompt
  3. Call Anthropic Claude API (claude-sonnet-4-6)
     - System: "You are a salon business intelligence assistant..."
     - User: context JSON + specific question or "generate insights"
  4. Return AI-generated insights in structured format:
     { insights: [{ type, title, description, recommendation, severity }] }

Env vars: ANTHROPIC_API_KEY

IMPORTANT: Never send PII (client names/emails) to the AI.
Only send aggregate business metrics.

### supabase/functions/ai-finance/index.ts
────────────────────────────────────────────────────────────────────────────────
Route: POST /functions/v1/ai-finance
Auth: Required (owner/manager)

Logic: Same pattern as ai-insights but finance-specific context:
  - Tax exposure estimate
  - Missing expense entries detection
  - Profitability trend analysis
  - Bookkeeping gaps detection
  - Plain-language P&L summary

### Realtime Subscriptions (no Edge Function needed)
────────────────────────────────────────────────────────────────────────────────
Supabase Realtime is enabled on: appointments table

Frontend: ReceptionistDashboard subscribes to:
  supabase.channel('appointments')
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'appointments',
      filter: `business_id=eq.${businessId}`
    }, payload => {
      // Update query cache via React Query
    })

### src/hooks/useNotifications.ts
  useNotifications() → useQuery + Realtime subscription
  useMarkNotificationRead() → useMutation
  useNotificationCount() → derived from useNotifications


## PHASE 6 — SUPPLIER & ADVANCED INTEGRATIONS
════════════════════════════════════════════════════════════════════════════════

### src/services/supplierService.ts
────────────────────────────────────────────────────────────────────────────────
export async function getSuppliers(businessId): Promise<Supplier[]>
export async function createSupplier(businessId, data)
export async function updateSupplier(id, data)
export async function getSupplierOrders(businessId, supplierId?): Promise<SupplierOrder[]>
export async function createSupplierOrder(businessId, data: CreateOrderData)
export async function updateOrderStatus(orderId, status: SupplierOrderStatus)
export async function getSupplierSpend(businessId, dateRange)
  → Aggregated spend by supplier for finance module

### supabase/functions/stripe-connect/index.ts
────────────────────────────────────────────────────────────────────────────────
(Phase 6 — enables salons to receive payouts directly)
Route: POST /functions/v1/stripe-connect
Action: create-account | get-dashboard-link | get-balance

Logic:
  → Stripe Connect Express accounts per business
  → Business receives payouts, platform takes fee
  → business_settings gets stripe_account_id field


## ENVIRONMENT VARIABLES REFERENCE
════════════════════════════════════════════════════════════════════════════════
File: .env.local (local dev)
File: Supabase Dashboard → Project Settings → Edge Functions → Secrets (production)

VITE_SUPABASE_URL          = https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY     = eyJ...
VITE_APP_URL               = http://localhost:8080
VITE_STRIPE_PUBLISHABLE_KEY = pk_test_...

# Edge Function secrets (not in .env, set in Supabase dashboard)
SUPABASE_SERVICE_ROLE_KEY  = eyJ...  (for Edge Functions to bypass RLS)
STRIPE_SECRET_KEY           = sk_test_...
STRIPE_WEBHOOK_SECRET       = whsec_...
RESEND_API_KEY              = re_...
ANTHROPIC_API_KEY           = sk-ant-...
APP_URL                     = https://your-domain.com


## MIGRATION EXECUTION ORDER
════════════════════════════════════════════════════════════════════════════════
Run in Supabase SQL Editor in this exact order:

1. 001_enums.sql               -- All CREATE TYPE statements
2. 002_core_tables.sql         -- businesses, users, business_members, business_settings
3. 003_service_catalog.sql     -- service_categories, services, service_translations
4. 004_staff_tables.sql        -- staff_profiles, staff_services, staff_working_hours, staff_time_off
5. 005_client_tables.sql       -- clients
6. 006_appointment_tables.sql  -- appointments, appointment_services, appointment_status_log
7. 007_payment_tables.sql      -- payments
8. 008_finance_tables.sql      -- suppliers, expenses, supplier_orders, supplier_order_items
9. 009_storefront_tables.sql   -- storefronts, storefront_gallery, promotions, reviews
10. 010_notification_tables.sql -- notifications, translations, guest_sessions
11. 011_triggers.sql           -- auto updated_at triggers, handle_new_user
12. 012_postgres_functions.sql -- all RPC functions
13. 013_rls_policies.sql       -- all RLS policies + grants
14. 014_seed_data.sql          -- global service categories, test business (dev only)


## FRONTEND WIRING PLAN (replacing mock data)
════════════════════════════════════════════════════════════════════════════════
Replace in this order (each step is independently testable):

Step 1: SalonStorefront.tsx + SalonServices.tsx + SalonBooking.tsx
  FROM: getStorefrontBySlug() from storefrontData.ts
  TO:   useStorefront(slug) → bookingService.getStorefront()
  Note: StorefrontData shape stays the same — backend returns matching structure

Step 2: SalonBooking.tsx — time slots
  FROM: static timeSlots array
  TO:   useAvailability({ businessId, serviceId, staffId, date })

Step 3: SalonBooking.tsx — submit booking
  FROM: setStep("confirmed") on "Confirm Booking" click
  TO:   useCreateBooking().mutate(bookingData) → handle Stripe + navigation

Step 4: CustomerBookings.tsx + BookingDetail.tsx
  FROM: getUpcomingBookings() / getPastBookings() from bookingsData.ts
  TO:   useCustomerBookings(userId) / useLookupBooking(email, ref)

Step 5: Owner AppointmentsPage.tsx
  FROM: appointmentData array in component files
  TO:   useAppointments(filters) → appointmentService

Step 6: Owner ClientsPage.tsx
  FROM: hardcoded client arrays
  TO:   useClients(filters) → clientService

Step 7: Owner StaffPage.tsx
  FROM: hardcoded staff arrays
  TO:   useStaffProfiles() → staffService

Step 8: Owner FinancePage.tsx
  FROM: all hardcoded numbers in finance components
  TO:   useRevenueSummary / useIncomeBreakdown / useExpenses / useTaxSummary

Step 9: Owner Dashboard KPIs
  FROM: hardcoded StatCard values
  TO:   useDashboardKPIs() → Postgres RPC

Step 10: AppSidebar.tsx — user info footer
  FROM: hardcoded "Jane Doe"
  TO:   useAuth() + useTenant() for real name + role


## FILE STRUCTURE (complete backend + service layer)
════════════════════════════════════════════════════════════════════════════════

supabase/
  migrations/
    001_enums.sql
    002_core_tables.sql
    003_service_catalog.sql
    004_staff_tables.sql
    005_client_tables.sql
    006_appointment_tables.sql
    007_payment_tables.sql
    008_finance_tables.sql
    009_storefront_tables.sql
    010_notification_tables.sql
    011_triggers.sql
    012_postgres_functions.sql
    013_rls_policies.sql
    014_seed_data.sql
  functions/
    _shared/                    -- shared utilities for all edge functions
      supabaseAdmin.ts          -- service role client
      stripe.ts                 -- Stripe instance
      resend.ts                 -- email client
      cors.ts                   -- CORS headers
      auth.ts                   -- auth verification helpers
    get-storefront/index.ts
    get-availability/index.ts
    create-booking/index.ts
    cancel-booking/index.ts
    reschedule-booking/index.ts
    lookup-booking/index.ts
    stripe-webhook/index.ts
    invite-staff/index.ts
    send-email/index.ts
    send-reminders/index.ts     -- cron
    export-report/index.ts
    ai-insights/index.ts
    ai-finance/index.ts
    stripe-connect/index.ts     -- Phase 6

src/
  types/
    database.ts                 -- (already written)
    api.ts                      -- API request/response types
    storefront.ts               -- matching storefrontData.ts interfaces
    booking.ts                  -- booking flow types
  lib/
    supabase.ts                 -- (already written)
    stripe.ts                   -- Stripe.js loader
  services/
    bookingService.ts
    appointmentService.ts
    clientService.ts
    staffService.ts
    financeService.ts
    storefrontService.ts
    supplierService.ts
    reviewService.ts
    notificationService.ts
  hooks/
    useAuth.ts                  -- (already written)
    useTenant.ts                -- (already written)
    useStorefront.ts            -- public storefront
    useOwnerStorefront.ts       -- owner-side storefront editor
    useAvailability.ts
    useCreateBooking.ts
    useAppointments.ts
    useCustomerBookings.ts
    useClients.ts
    useStaff.ts
    useFinance.ts
    useReports.ts
    useSuppliers.ts
    useReviews.ts
    useNotifications.ts
    useMarketplace.ts
  contexts/
    AuthContext.tsx              -- (already written)
    TenantContext.tsx            -- (already written)
  components/
    auth/
      ProtectedRoute.tsx        -- (already written)
      RoleRoute.tsx             -- (already written)
    stripe/
      PaymentElement.tsx        -- Stripe Elements wrapper for booking flow


## CRITICAL IMPLEMENTATION NOTES
════════════════════════════════════════════════════════════════════════════════

1. AVAILABILITY ENGINE — Race condition prevention
   The get_available_slots() function alone is not enough.
   create-booking Edge Function must use a Postgres transaction with:
   SELECT ... FOR UPDATE on the appointments table
   to prevent double-booking when two users submit simultaneously.

2. STRIPE — Never store card data
   Use Stripe Elements + PaymentIntents.
   create-booking creates the PaymentIntent and returns client_secret.
   Frontend uses Stripe.js to collect card and confirm.
   stripe-webhook handles the actual confirmation asynchronously.

3. GUEST BOOKINGS — Email is the identity
   Guest clients are identified by (business_id, email).
   If the same email books again, we update the existing client record.
   Guest lookup uses booking_reference + email (both required = auth-equivalent).
   guest_sessions table provides short-lived tokens for reschedule/cancel links.

4. RLS + EDGE FUNCTIONS
   Edge Functions run with the service role key (bypasses RLS).
   They must implement their own authorization logic.
   Never expose the service role key to the frontend.
   Always validate that the authenticated user has permission for the operation.

5. REALTIME — Selective subscription
   Only subscribe to realtime on pages that actually need it:
   - ReceptionistDashboard: appointments table
   - Owner Dashboard: appointments table (today only)
   Not on every page — realtime connections are finite.

6. IMAGE UPLOADS — Always via Supabase Storage
   Never store base64 images in the database.
   Upload to Storage → get URL → store URL in the relevant table.
   Use Supabase Storage policies to control access.
   Public bucket for gallery/logos, private bucket for receipts.

7. AI — Context window management
   Never send unbounded data to Claude API.
   Always cap the data: max 90 days, max 1000 rows.
   Pre-aggregate in Postgres before sending to AI.
   Cache AI responses for 1 hour (don't re-query on every page visit).

8. i18n — Frontend locale vs. backend content locale
   Frontend locale (I18nContext): controls UI strings (buttons, labels)
   Backend content locale: controls translated service names, storefront content
   The get-storefront Edge Function accepts Accept-Language header
   and joins service_translations to return locale-appropriate content.

9. BOOKING REFERENCE FORMAT
   Format: KZB-XXXXX where X is base-36 (0-9, A-Z)
   5 chars = 36^5 = 60M combinations, enough for millions of salons
   generate_booking_reference() Postgres function handles collision retry.

10. ERROR HANDLING STANDARDS
    All Edge Functions return consistent error format:
    { error: { code: string, message: string, details?: any } }
    HTTP status codes: 400 (bad input), 401 (unauth), 403 (forbidden),
                       404 (not found), 409 (conflict/race), 500 (internal)
    Frontend service layer translates these to typed errors for React Query.
════════════════════════════════════════════════════════════════════════════════
END OF PLAN