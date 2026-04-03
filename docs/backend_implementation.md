# KaziOne Booking — Backend Implementation Plan

> **Codebase state as of 2026-04-03**
> Frontend: React 18 + TypeScript + Vite + React Query (installed, unused)
> Backend: **None** — all data is hardcoded mock data
> Database: **None**

---

## Table of Contents

1. [Broken Links & Frontend Gaps](#1-broken-links--frontend-gaps)
2. [Recommended Stack](#2-recommended-stack)
3. [Database Schema](#3-database-schema)
4. [API Endpoint Reference](#4-api-endpoint-reference)
   - [Auth](#41-auth)
   - [Salons / Storefronts](#42-salons--storefronts)
   - [Services](#43-services)
   - [Team / Staff](#44-team--staff)
   - [Appointments / Bookings](#45-appointments--bookings)
   - [Clients](#46-clients)
   - [Finance](#47-finance)
   - [Suppliers](#48-suppliers)
   - [Marketplace](#49-marketplace)
   - [Reports & Insights](#410-reports--insights)
   - [Settings](#411-settings)
   - [File Upload](#412-file-upload)
5. [Frontend Integration Checklist](#5-frontend-integration-checklist)
6. [Auth & Role Guard Strategy](#6-auth--role-guard-strategy)
7. [Implementation Order](#7-implementation-order)

---

## 1. Broken Links & Frontend Gaps

### ❌ Routes defined in sidebar but missing in `App.tsx`

| Role | Sidebar URL | Status |
|------|-------------|--------|
| Receptionist | `/receptionist/calendar` | Not defined — falls to `ReceptionistDashboard` catch-all |
| Receptionist | `/receptionist/walkins` | Not defined |
| Receptionist | `/receptionist/clients` | Not defined |
| Receptionist | `/receptionist/payments` | Not defined |
| Client | `/client/book` | Not defined (should be `/client/browse`) |
| Client | `/client/favorites` | Not defined — no page component |
| Client | `/client/profile` | Not defined — no page component |
| Partner | `/partner/salons` | Not defined |
| Partner | `/partner/analytics` | Not defined |
| Partner | `/partner/onboarding` | Not defined |
| Partner | `/partner/settings` | Not defined |

### ❌ Pages that exist but are 100% mock data (no API calls)

Every single page — all data is hardcoded. Specifically:

- `AppointmentsPage` — static stat cards (12, 47, 35, 4), static service/staff lists
- `FinancePage` — all sub-tabs (income, expenses, tax, annual) render mock data
- `ClientsPage` — hardcoded client list
- `StaffPage` — hardcoded staff list
- `SalonBooking` — time slots are a static array; availability is never checked
- `CustomerBookings` / `BookingDetail` — reads from `sampleBookings` array
- `BrowseSalons` — reads from `getAllListedStorefronts()` (single hardcoded salon)
- `SalonStorefront` — reads from `getStorefrontBySlug()` (single hardcoded salon)
- `ReportsPage`, `AIInsightsPage`, `SuppliersPage` — all mock

### ⚠️ Time slots not availability-aware

`SalonBooking.tsx` shows a fixed array of 19 time slots with no check against:
- Staff working hours
- Existing bookings for that slot
- Salon opening hours

---

## 2. Recommended Stack

```
Backend:  Node.js + Express (or Fastify) + TypeScript
Database: PostgreSQL (via Prisma ORM)
Auth:     JWT (access + refresh tokens) + bcrypt
Storage:  AWS S3 / Cloudflare R2 (images, exports)
Payments: Stripe
AI:       Anthropic Claude API (for AIInsightsPage / AIFinanceAssistant)
Email:    Resend or SendGrid
Cache:    Redis (availability slots, rate-limiting)
```

### Environment variables needed

```env
DATABASE_URL=
JWT_SECRET=
JWT_REFRESH_SECRET=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
AWS_S3_BUCKET=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
ANTHROPIC_API_KEY=
RESEND_API_KEY=
REDIS_URL=
```

---

## 3. Database Schema

```prisma
// prisma/schema.prisma

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  role         Role     @default(CLIENT)
  name         String
  phone        String?
  avatarUrl    String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  // relations
  ownedSalons  Salon[]        @relation("SalonOwner")
  staffProfile StaffMember?
  bookings     Booking[]      @relation("CustomerBookings")
  favorites    Favorite[]
  reviews      Review[]
  tokens       RefreshToken[]
}

enum Role {
  OWNER
  STAFF
  RECEPTIONIST
  CLIENT
  PARTNER
  ADMIN
}

model Salon {
  id          String   @id @default(cuid())
  slug        String   @unique
  name        String
  ownerId     String
  owner       User     @relation("SalonOwner", fields: [ownerId], references: [id])
  verified    Boolean  @default(false)
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  // storefront content
  logoUrl           String?
  coverUrl          String?
  heroTitle         String?
  heroTagline       String?
  highlightTag      String?
  primaryCTA        String   @default("Book Appointment")
  secondaryCTA      String   @default("Explore Services")
  description       String?
  extendedDesc      String?
  specialties       String[]

  // contact
  address   String?
  phone     String?
  website   String?
  hours     String?
  teamSize  String?
  location  String?

  // aggregate stats (updated by cron or triggers)
  rating      Float  @default(0)
  reviewCount Int    @default(0)

  // section visibility flags (stored as JSON or booleans)
  sectionHero       Boolean @default(true)
  sectionAbout      Boolean @default(true)
  sectionServices   Boolean @default(true)
  sectionPromotions Boolean @default(true)
  sectionGallery    Boolean @default(true)
  sectionTeam       Boolean @default(true)
  sectionReviews    Boolean @default(true)
  sectionBooking    Boolean @default(true)

  // relations
  services    Service[]
  staff       StaffMember[]
  promotions  Promotion[]
  reviews     Review[]
  gallery     GalleryImage[]
  bookings    Booking[]
  favorites   Favorite[]
  listing     MarketplaceListing?
  suppliers   Supplier[]
  expenses    Expense[]
}

model Service {
  id          String   @id @default(cuid())
  salonId     String
  salon       Salon    @relation(fields: [salonId], references: [id])
  name        String
  category    String
  description String?
  duration    String   // e.g. "3-4 hrs"
  durationMin Int      // in minutes, for slot calculation
  price       Float
  currency    String   @default("EUR")
  popular     Boolean  @default(false)
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())

  bookings    Booking[]
}

model StaffMember {
  id        String   @id @default(cuid())
  salonId   String
  salon     Salon    @relation(fields: [salonId], references: [id])
  userId    String?  @unique
  user      User?    @relation(fields: [userId], references: [id])
  name      String
  role      String
  specialty String?
  imageUrl  String?
  rating    Float    @default(0)
  featured  Boolean  @default(false)
  active    Boolean  @default(true)
  createdAt DateTime @default(now())

  bookings    Booking[]
  schedule    ScheduleSlot[]
}

model ScheduleSlot {
  id          String   @id @default(cuid())
  staffId     String
  staff       StaffMember @relation(fields: [staffId], references: [id])
  dayOfWeek   Int      // 0=Sun ... 6=Sat
  startTime   String   // "10:00"
  endTime     String   // "20:00"
  isOff       Boolean  @default(false)
}

model Booking {
  id              String        @id @default(cuid())
  reference       String        @unique @default(cuid()) // KZB-XXXXX format
  salonId         String
  salon           Salon         @relation(fields: [salonId], references: [id])
  serviceId       String
  service         Service       @relation(fields: [serviceId], references: [id])
  staffId         String?
  staff           StaffMember?  @relation(fields: [staffId], references: [id])
  customerId      String?
  customer        User?         @relation("CustomerBookings", fields: [customerId], references: [id])

  // guest booking fields
  guestName       String?
  guestEmail      String?
  guestPhone      String?
  isGuest         Boolean       @default(false)

  // scheduling
  date            DateTime
  time            String        // "11:00"
  durationMin     Int

  // status
  status          BookingStatus @default(PENDING)

  // payment
  paymentMethod   PaymentMethod @default(DEPOSIT)
  paymentStatus   PaymentStatus @default(PENDING_PAYMENT)
  servicePrice    Float
  depositAmount   Float         @default(0)
  totalPaid       Float         @default(0)
  remainingBalance Float        @default(0)
  stripePaymentIntentId String?

  // meta
  notes           String?
  cancellationPolicy String?
  canReschedule   Boolean       @default(true)
  canCancel       Boolean       @default(true)
  cancelledAt     DateTime?
  cancelReason    String?
  createdAt       DateTime      @default(now())
  updatedAt       DateTime      @updatedAt
}

enum BookingStatus {
  PENDING
  CONFIRMED
  COMPLETED
  CANCELLED
  NO_SHOW
}

enum PaymentMethod {
  DEPOSIT
  FULL
  LATER
}

enum PaymentStatus {
  PENDING_PAYMENT
  DEPOSIT_PAID
  FULLY_PAID
  PAY_LATER
  REFUNDED
  PARTIALLY_REFUNDED
}

model Promotion {
  id          String   @id @default(cuid())
  salonId     String
  salon       Salon    @relation(fields: [salonId], references: [id])
  title       String
  description String
  discount    String
  period      String
  badge       String?
  active      Boolean  @default(true)
  createdAt   DateTime @default(now())
}

model Review {
  id        String   @id @default(cuid())
  salonId   String
  salon     Salon    @relation(fields: [salonId], references: [id])
  userId    String?
  user      User?    @relation(fields: [userId], references: [id])
  name      String
  rating    Int      // 1-5
  text      String
  createdAt DateTime @default(now())
}

model GalleryImage {
  id        String   @id @default(cuid())
  salonId   String
  salon     Salon    @relation(fields: [salonId], references: [id])
  url       String
  order     Int      @default(0)
  createdAt DateTime @default(now())
}

model MarketplaceListing {
  id               String          @id @default(cuid())
  salonId          String          @unique
  salon            Salon           @relation(fields: [salonId], references: [id])
  status           ListingStatus   @default(DRAFT)
  featured         Boolean         @default(false)
  title            String
  headline         String?
  shortDescription String?
  categories       String[]
  tags             String[]
  coverUrl         String?
  updatedAt        DateTime        @updatedAt
}

enum ListingStatus {
  ACTIVE
  HIDDEN
  DRAFT
}

model Favorite {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  salonId   String
  salon     Salon    @relation(fields: [salonId], references: [id])
  createdAt DateTime @default(now())

  @@unique([userId, salonId])
}

model Supplier {
  id        String   @id @default(cuid())
  salonId   String
  salon     Salon    @relation(fields: [salonId], references: [id])
  name      String
  category  String
  contactName String?
  email     String?
  phone     String?
  website   String?
  notes     String?
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
}

model Expense {
  id          String   @id @default(cuid())
  salonId     String
  salon       Salon    @relation(fields: [salonId], references: [id])
  category    String
  description String
  amount      Float
  currency    String   @default("EUR")
  date        DateTime
  supplierId  String?
  receiptUrl  String?
  createdAt   DateTime @default(now())
}

model RefreshToken {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  token     String   @unique
  expiresAt DateTime
  createdAt DateTime @default(now())
}
```

---

## 4. API Endpoint Reference

Base URL: `https://api.kazionebooking.com/v1`
All protected routes require: `Authorization: Bearer <access_token>`

---

### 4.1 Auth

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/auth/register` | Public | Register new user (client default) |
| POST | `/auth/login` | Public | Login, returns access + refresh token |
| POST | `/auth/refresh` | Public | Exchange refresh token for new access token |
| POST | `/auth/logout` | Bearer | Revoke refresh token |
| POST | `/auth/forgot-password` | Public | Send password reset email |
| POST | `/auth/reset-password` | Public | Reset password with token |
| GET | `/auth/me` | Bearer | Get current user profile |
| PATCH | `/auth/me` | Bearer | Update current user (name, phone, avatar) |
| PATCH | `/auth/me/password` | Bearer | Change password |

**Register request body:**
```json
{
  "name": "Zara M.",
  "email": "zara@example.com",
  "password": "...",
  "phone": "+372 5123 4567",
  "role": "CLIENT"
}
```

**Login response:**
```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "user": { "id", "name", "email", "role" }
}
```

---

### 4.2 Salons / Storefronts

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/salons` | Public | List all active marketplace salons (browse page) |
| GET | `/salons/:slug` | Public | Get full storefront data for a salon |
| POST | `/salons` | Owner | Create a new salon |
| PATCH | `/salons/:slug` | Owner | Update salon storefront content |
| PATCH | `/salons/:slug/sections` | Owner | Toggle section visibility |
| DELETE | `/salons/:slug` | Owner | Soft-delete salon |

**GET /salons query params:**
```
?search=braids
?category=Braids,Locs
?location=Tallinn
?featured=true
?page=1&limit=20
```

**GET /salons response (list item):**
```json
{
  "slug": "afrotouch",
  "name": "Afrotouch Tallinn",
  "logoUrl": "...",
  "coverUrl": "...",
  "location": "Tallinn, Estonia",
  "rating": 4.9,
  "reviewCount": 128,
  "verified": true,
  "headline": "Afro-textured Hair Specialists",
  "shortDescription": "...",
  "categories": ["Hair", "Braids"],
  "tags": ["Braids", "Locs"]
}
```

**GET /salons/:slug response (full storefront):**
Returns the full `StorefrontData` shape matching the existing TypeScript interface — including services, team, promotions, gallery, reviews, contact, sections.

---

### 4.3 Services

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/salons/:slug/services` | Public | List all active services for a salon |
| POST | `/salons/:slug/services` | Owner | Create a new service |
| PATCH | `/salons/:slug/services/:id` | Owner | Update a service |
| DELETE | `/salons/:slug/services/:id` | Owner | Soft-delete a service |
| PATCH | `/salons/:slug/services/reorder` | Owner | Reorder services |

**POST /salons/:slug/services request body:**
```json
{
  "name": "Knotless Braids",
  "category": "Braids",
  "description": "Lightweight, natural-looking braids...",
  "duration": "3-4 hrs",
  "durationMin": 210,
  "price": 120,
  "currency": "EUR",
  "popular": true
}
```

---

### 4.4 Team / Staff

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/salons/:slug/staff` | Public | List featured staff for booking |
| GET | `/salons/:slug/staff/:id` | Public | Get staff member detail |
| POST | `/salons/:slug/staff` | Owner | Add staff member |
| PATCH | `/salons/:slug/staff/:id` | Owner | Update staff member |
| DELETE | `/salons/:slug/staff/:id` | Owner | Remove staff member |
| GET | `/salons/:slug/staff/:id/availability` | Public | Get available slots for a staff + date |
| GET | `/salons/:slug/staff/:id/schedule` | Owner/Staff | Get weekly schedule |
| PATCH | `/salons/:slug/staff/:id/schedule` | Owner | Update working hours |

**GET /salons/:slug/staff/:id/availability query params:**
```
?date=2026-04-08
?serviceId=s1   (used to determine duration and block adequate time)
```

**GET /salons/:slug/staff/:id/availability response:**
```json
{
  "date": "2026-04-08",
  "slots": [
    { "time": "10:00", "available": true },
    { "time": "10:30", "available": false },
    { "time": "11:00", "available": true }
  ]
}
```

> **Important:** This replaces the static `timeSlots` array in `SalonBooking.tsx`. The calculation must account for service duration (`durationMin`), staff schedule, and existing bookings.

---

### 4.5 Appointments / Bookings

#### Public (Customer-facing)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/bookings` | Public/Bearer | Create a booking (guest or logged-in) |
| GET | `/bookings/me` | Bearer | Get current user's bookings |
| GET | `/bookings/:id` | Bearer/Guest token | Get single booking detail |
| PATCH | `/bookings/:id/cancel` | Bearer/Guest token | Cancel a booking |
| PATCH | `/bookings/:id/reschedule` | Bearer | Reschedule a booking |
| POST | `/bookings/:id/payment` | Bearer | Complete remaining payment |

**POST /bookings request body (guest):**
```json
{
  "salonSlug": "afrotouch",
  "serviceId": "s1",
  "staffId": "t1",
  "date": "2026-04-08",
  "time": "11:00",
  "paymentMethod": "deposit",
  "guestName": "Zara M.",
  "guestEmail": "zara@example.com",
  "guestPhone": "+372 5123 4567",
  "notes": "Please use lightweight extensions"
}
```

**POST /bookings response:**
```json
{
  "id": "bk-001",
  "reference": "KZB-7FA3X",
  "status": "CONFIRMED",
  "stripePaymentIntentClientSecret": "pi_..._secret_..."
}
```

**GET /bookings/me query params:**
```
?status=confirmed,pending   (upcoming)
?status=completed,cancelled (past)
?page=1&limit=20
```

#### Owner/Receptionist dashboard

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/owner/bookings` | Owner/Receptionist | List all salon bookings |
| GET | `/owner/bookings/today` | Owner/Receptionist | Today's bookings + KPIs |
| GET | `/owner/bookings/:id` | Owner/Receptionist | Booking detail |
| PATCH | `/owner/bookings/:id/status` | Owner/Receptionist | Mark completed / no-show |
| POST | `/owner/bookings/walkin` | Owner/Receptionist | Create walk-in booking |
| DELETE | `/owner/bookings/:id` | Owner | Delete booking |

**GET /owner/bookings query params:**
```
?date=2026-04-08
?staffId=t1
?status=CONFIRMED,PENDING
?search=Zara
?page=1&limit=50
```

**GET /owner/bookings/today response:**
```json
{
  "kpis": {
    "totalToday": 12,
    "remaining": 5,
    "completedThisWeek": 35,
    "cancelledThisWeek": 4,
    "completionRate": 0.74,
    "cancellationRate": 0.08
  },
  "bookings": [...]
}
```

**POST /owner/bookings/walkin request body:**
```json
{
  "serviceId": "s1",
  "staffId": "t1",
  "clientName": "Walk-in Customer",
  "clientPhone": "+372 ...",
  "date": "2026-04-03",
  "time": "14:00",
  "paymentMethod": "FULL"
}
```

---

### 4.6 Clients

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/owner/clients` | Owner | List all clients who booked this salon |
| GET | `/owner/clients/:id` | Owner | Client detail + booking history |
| PATCH | `/owner/clients/:id/notes` | Owner | Add internal notes to client |
| GET | `/owner/clients/:id/bookings` | Owner | Client's booking history |
| GET | `/staff/clients` | Staff | Staff's assigned client list |

**GET /owner/clients query params:**
```
?search=Zara
?sortBy=lastVisit|totalSpent|name
?page=1&limit=50
```

**GET /owner/clients response:**
```json
{
  "clients": [
    {
      "id": "...",
      "name": "Zara M.",
      "email": "zara@example.com",
      "phone": "+372 ...",
      "totalBookings": 5,
      "totalSpent": 430,
      "lastVisit": "2026-03-20",
      "status": "active",
      "notes": "Prefers lightweight extensions"
    }
  ],
  "pagination": { "total": 124, "page": 1, "limit": 50 }
}
```

---

### 4.7 Finance

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/owner/finance/overview` | Owner | Summary KPIs (revenue, expenses, profit) |
| GET | `/owner/finance/income` | Owner | Income breakdown by period |
| GET | `/owner/finance/expenses` | Owner | Expense list |
| POST | `/owner/finance/expenses` | Owner | Log an expense |
| PATCH | `/owner/finance/expenses/:id` | Owner | Update expense |
| DELETE | `/owner/finance/expenses/:id` | Owner | Delete expense |
| GET | `/owner/finance/profitability` | Owner | Revenue vs expenses by month/service |
| GET | `/owner/finance/tax` | Owner | Tax summary (VAT, income) |
| GET | `/owner/finance/export` | Owner | Generate accountant CSV/PDF export |
| GET | `/owner/finance/annual` | Owner | Annual financial report |
| GET | `/owner/finance/config` | Owner | Tax configuration |
| PATCH | `/owner/finance/config` | Owner | Update tax config (country, VAT rate, etc.) |

**GET /owner/finance/overview query params:**
```
?period=month|quarter|year
?from=2026-01-01&to=2026-03-31
```

**GET /owner/finance/overview response:**
```json
{
  "revenue": {
    "total": 8420,
    "change": 12.4,
    "currency": "EUR"
  },
  "expenses": {
    "total": 2150,
    "change": -3.1
  },
  "profit": {
    "total": 6270,
    "margin": 0.744
  },
  "bookings": {
    "total": 67,
    "avgTicket": 125.7
  },
  "chart": [
    { "month": "Jan", "revenue": 2100, "expenses": 540 },
    { "month": "Feb", "revenue": 2800, "expenses": 710 }
  ]
}
```

**POST /owner/finance/expenses request body:**
```json
{
  "category": "Products",
  "description": "Hair extensions stock",
  "amount": 320,
  "date": "2026-04-01",
  "supplierId": "sup-001",
  "receiptUrl": "..."
}
```

---

### 4.8 Suppliers

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/owner/suppliers` | Owner | List salon suppliers |
| POST | `/owner/suppliers` | Owner | Add supplier |
| PATCH | `/owner/suppliers/:id` | Owner | Update supplier |
| DELETE | `/owner/suppliers/:id` | Owner | Remove supplier |

**POST /owner/suppliers request body:**
```json
{
  "name": "HairPro Wholesale",
  "category": "Extensions",
  "contactName": "Maria Santos",
  "email": "info@hairpro.ee",
  "phone": "+372 ...",
  "website": "hairpro.ee",
  "notes": "Main extension supplier, net-30 terms"
}
```

---

### 4.9 Marketplace

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/marketplace` | Public | Browse all listed salons |
| GET | `/marketplace/featured` | Public | Featured salons for homepage |
| GET | `/marketplace/categories` | Public | List all categories |
| GET | `/owner/marketplace/listing` | Owner | Get own listing status |
| PATCH | `/owner/marketplace/listing` | Owner | Update listing (title, description, tags, status) |
| POST | `/client/favorites` | Bearer | Add salon to favorites |
| DELETE | `/client/favorites/:salonSlug` | Bearer | Remove from favorites |
| GET | `/client/favorites` | Bearer | Get user's favorite salons |

**GET /marketplace query params:**
```
?search=braids
?category=Natural Hair
?location=Tallinn
?featured=true
?sortBy=rating|distance|newest
?page=1&limit=20
```

---

### 4.10 Reports & Insights

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/owner/reports/summary` | Owner | High-level KPI summary |
| GET | `/owner/reports/revenue` | Owner | Revenue by service/staff/period |
| GET | `/owner/reports/bookings` | Owner | Booking volume trends |
| GET | `/owner/reports/staff` | Owner | Per-staff performance |
| GET | `/owner/reports/clients` | Owner | Client retention, new vs returning |
| GET | `/owner/reports/export` | Owner | Download report as CSV/PDF |
| POST | `/owner/insights/ai` | Owner | Ask AI for business insights |
| GET | `/staff/performance` | Staff | Individual staff performance report |

**GET /owner/reports/summary query params:**
```
?period=week|month|quarter|year
?from=2026-01-01&to=2026-03-31
```

**POST /owner/insights/ai request body:**
```json
{
  "question": "What are my busiest days and which staff generates the most revenue?"
}
```

**POST /owner/insights/ai response:**
```json
{
  "answer": "...",
  "data": { "chart": [...], "highlights": [...] }
}
```

> This endpoint calls the Anthropic API using the salon's aggregated data as context.

---

### 4.11 Settings

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/owner/settings` | Owner | Get all salon settings |
| PATCH | `/owner/settings/general` | Owner | Update general info |
| PATCH | `/owner/settings/booking` | Owner | Booking rules (deposit %, cancellation policy) |
| PATCH | `/owner/settings/notifications` | Owner | Email/SMS notification prefs |
| PATCH | `/owner/settings/payments` | Owner | Stripe connect / payout settings |
| GET | `/owner/settings/payments/connect` | Owner | Get Stripe Connect onboarding URL |

**GET /owner/settings/booking response:**
```json
{
  "depositPercent": 25,
  "allowPayLater": true,
  "cancellationHours": 24,
  "rescheduleHours": 24,
  "autoConfirm": true,
  "maxAdvanceDays": 60,
  "bufferMinutes": 15
}
```

---

### 4.12 File Upload

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/upload/image` | Bearer | Upload image, returns URL |
| DELETE | `/upload/image` | Bearer | Delete image by URL |

**POST /upload/image:**
- Content-Type: `multipart/form-data`
- Field: `file` (image)
- Field: `context`: `"logo" | "cover" | "gallery" | "staff" | "receipt"`

**Response:**
```json
{ "url": "https://cdn.kazionebooking.com/..." }
```

---

## 5. Frontend Integration Checklist

Replace each mock data source with a React Query hook:

### Replace `src/data/storefrontData.ts` usage

| File | Current | Replace with |
|------|---------|--------------|
| `SalonStorefront.tsx` | `getStorefrontBySlug(slug)` | `useQuery(['salon', slug], () => api.get('/salons/' + slug))` |
| `SalonServices.tsx` | Same storefront data | `useQuery(['services', slug], () => api.get('/salons/' + slug + '/services'))` |
| `BrowseSalons.tsx` | `getAllListedStorefronts()` | `useQuery(['marketplace'], () => api.get('/marketplace'))` |
| `MarketplaceHome.tsx` | Static data | `useQuery(['featured'], () => api.get('/marketplace/featured'))` |
| `SalonBooking.tsx` | Static time slots | `useQuery(['availability', staffId, date], () => api.get(...))` |
| `StorefrontEditorPage.tsx` | Static storefront | `useQuery + useMutation for PATCH /salons/:slug` |

### Replace `src/data/bookingsData.ts` usage

| File | Current | Replace with |
|------|---------|--------------|
| `CustomerBookings.tsx` | `sampleBookings` | `useQuery(['bookings'], () => api.get('/bookings/me'))` |
| `BookingDetail.tsx` | `getBookingById(id)` | `useQuery(['booking', id], () => api.get('/bookings/' + id))` |

### Owner dashboard pages

| Page | Endpoint(s) needed |
|------|--------------------|
| `AppointmentsPage` | `GET /owner/bookings/today`, `GET /owner/bookings`, `POST /owner/bookings`, `POST /owner/bookings/walkin` |
| `ClientsPage` | `GET /owner/clients`, `GET /owner/clients/:id` |
| `StaffPage` | `GET /salons/:slug/staff`, `POST/PATCH/DELETE /salons/:slug/staff/:id` |
| `FinancePage` | All `/owner/finance/*` endpoints |
| `ReportsPage` | All `/owner/reports/*` endpoints |
| `AIInsightsPage` | `POST /owner/insights/ai` |
| `SuppliersPage` | All `/owner/suppliers` endpoints |
| `StorefrontEditorPage` | `GET/PATCH /salons/:slug`, gallery upload |
| `MarketplaceListingPage` | `GET/PATCH /owner/marketplace/listing` |
| `SettingsPage` | All `/owner/settings/*` endpoints |

---

## 6. Auth & Role Guard Strategy

### Missing: No auth exists in the frontend

Currently any user can access `/owner`, `/staff`, `/receptionist`, `/partner` with no login gate.

**Required additions to `App.tsx`:**

```tsx
// Wrap protected routes with a RoleGuard component
<Route path="/owner/*" element={
  <RoleGuard requiredRole="OWNER">
    <OwnerDashboard />
  </RoleGuard>
} />
```

**`RoleGuard` component logic:**
1. Read JWT from `localStorage` / `httpOnly` cookie
2. If no token → redirect to `/login`
3. Decode token, check `role` claim
4. If role mismatch → redirect to role-appropriate dashboard or `/unauthorized`

**Missing pages to create:**
- `/login` — email + password form
- `/register` — signup form  
- `/unauthorized` — access denied page
- `/forgot-password` — password reset flow

### JWT payload shape

```json
{
  "sub": "user-cuid",
  "email": "owner@afrotouch.ee",
  "role": "OWNER",
  "salonSlug": "afrotouch",
  "iat": 1234567890,
  "exp": 1234567890
}
```

The `salonSlug` claim lets the backend verify the owner is acting on their own salon without an extra DB lookup.

---

## 7. Implementation Order

### Phase 1 — Core Infrastructure (Week 1)

- [ ] Set up Node/Express + TypeScript + Prisma
- [ ] Create PostgreSQL schema (run migrations)
- [ ] `POST /auth/register`, `POST /auth/login`, JWT middleware
- [ ] `GET /salons/:slug` — serve storefront data from DB
- [ ] `GET /marketplace` — browse salons
- [ ] Seed DB with Afrotouch data from `storefrontData.ts`

### Phase 2 — Booking Flow (Week 2)

- [ ] `GET /salons/:slug/staff/:id/availability` — real slot calculation
- [ ] `POST /bookings` — create booking (guest + logged-in)
- [ ] Stripe Payment Intent creation for deposit/full payment
- [ ] Stripe webhook for payment confirmation → update `paymentStatus`
- [ ] Booking confirmation email (Resend)
- [ ] `GET /bookings/me`, `GET /bookings/:id`
- [ ] `PATCH /bookings/:id/cancel`

### Phase 3 — Owner Dashboard APIs (Week 3)

- [ ] `GET /owner/bookings/today` + `GET /owner/bookings`
- [ ] `POST /owner/bookings/walkin`
- [ ] `GET /owner/clients`
- [ ] All `/owner/finance/*` endpoints
- [ ] All `/owner/suppliers` endpoints

### Phase 4 — Storefront Editor & Staff (Week 4)

- [ ] `PATCH /salons/:slug` — update storefront content
- [ ] `POST/PATCH/DELETE /salons/:slug/services/:id`
- [ ] `POST/PATCH/DELETE /salons/:slug/staff/:id`
- [ ] `PATCH /salons/:slug/staff/:id/schedule`
- [ ] `POST /upload/image` — S3 integration
- [ ] `PATCH /owner/marketplace/listing`

### Phase 5 — Frontend Wiring (Week 5)

- [ ] Create `src/lib/api.ts` (axios instance with token interceptor)
- [ ] Create React Query hooks for each domain
- [ ] Replace all mock data imports with `useQuery` / `useMutation`
- [ ] Add `RoleGuard`, `/login`, `/register`, `/forgot-password` pages
- [ ] Fix broken sidebar routes (add missing receptionist/partner sub-routes)

### Phase 6 — Reports, AI & Polish (Week 6)

- [ ] `GET /owner/reports/*` endpoints
- [ ] `POST /owner/insights/ai` (Claude API integration)
- [ ] `GET /staff/performance`
- [ ] Settings endpoints
- [ ] Email notifications (booking reminders, cancellations)
- [ ] End-to-end tests with Playwright

---

## Appendix: Suggested `src/lib/api.ts`

```typescript
import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:3001/v1",
  headers: { "Content-Type": "application/json" },
});

// Attach access token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("access_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auto-refresh on 401
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config;
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true;
      const refreshToken = localStorage.getItem("refresh_token");
      const { data } = await axios.post("/auth/refresh", { refreshToken });
      localStorage.setItem("access_token", data.accessToken);
      original.headers.Authorization = `Bearer ${data.accessToken}`;
      return api(original);
    }
    return Promise.reject(err);
  }
);

export default api;
```

---

*Generated 2026-04-03 via code review of `afrotouch-salon-os` frontend.*
