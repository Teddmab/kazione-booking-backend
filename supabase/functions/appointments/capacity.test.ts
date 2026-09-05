// supabase/functions/appointments/capacity.test.ts
//
// Corrected salon-capacity model (136_seat_capacity_shadow.sql): capacity is
// a COUNT of overlapping capacity-blocking appointments against a
// business-level business_settings.seat_count, evaluated inside the single
// shared check_and_reserve_slot function every write path already calls.
// Stage 1 is shadow-only — every scenario below expects the booking itself
// to still succeed; only appointment_capacity_shadow_log is asserted on.
//
// Like every other *.test.ts in this repo, tests that need a real owner JWT
// are gated behind `if (!OWNER_TOKEN) return` and silently no-op without a
// live local Supabase + TEST_OWNER_TOKEN — see CLAUDE.md's note that this
// dev sandbox has no Docker, so these only prove anything real in CI (or a
// local run once TEST_OWNER_TOKEN is provisioned against `supabase start`).
import { assertEquals } from "std/assert"
import { localWallClockToUtcIso } from "../_shared/timezone.ts"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const SUPABASE_URL = "http://127.0.0.1:54321"
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"

const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // Afrotouch, from seed
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001" // Knotless Braids
const DUAL_STAFF_SERVICE_ID = "c0000000-0000-4000-8000-000000000005" // requires_two_staff=true, S58 fixture
const STAFF_ID = "d0000000-0000-4000-8000-000000000001" // Fatima K.
const STAFF_ID_2 = "d0000000-0000-4000-8000-000000000002" // Regina M. — only two staff exist on this
// seed business, so tests below prove the COUNT(*)-vs-threshold algorithm at
// capacity=1/2 rather than the spec's illustrative capacity=3/five-staff
// numbers — the SQL predicate is identical at any scale, so this is a
// faithful (not scaled-down-in-substance) test of the same logic.
const CLIENT_ID = "c1000000-0000-4000-8000-000000000001" // Amara Diallo
const CLIENT_ID_2 = "c1000000-0000-4000-8000-000000000002" // Sophie Martin
const LOC_MAINTENANCE_SERVICE_ID = "c0000000-0000-4000-8000-000000000003" // Regina's service, 120-min

// 141_cross_business_conflict_visibility.sql fixtures. Foreign Test Salon
// (S74) is deliberately minimal in seed.sql (no services/staff of its own)
// until these tests add one. SHARED_PERSON_USER_ID reuses the seeded
// customer account's real auth-backed user id purely as a valid FK target
// for business_members.user_id — these tests never authenticate as that
// person, they only need users.id -> auth.users.id to resolve.
const FOREIGN_BUSINESS_ID = "b0000000-0000-4000-8000-000000000002"
const SHARED_PERSON_USER_ID = "f0000000-0000-4000-8000-000000000002"
const XBIZ_AFROTOUCH_STAFF_ID = "d0000000-0000-4000-8000-0000000000f1"
const XBIZ_FOREIGN_STAFF_ID = "d0000000-0000-4000-8000-0000000000f2"

const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

// Afrotouch's business_settings.booking_future_days is only 60
// (014_seed_data.sql), so the get-availability/create-booking tests below
// (unlike the rest of this file, which goes through the owner-authoritative
// `appointments` endpoint) need a date relative to "now" rather than a
// hardcoded far-future one — see get-availability.test.ts's own copy of
// this helper for the OUTSIDE_BOOKING_WINDOW failure mode this avoids.
function futureBusinessDate(minOffsetDays: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + minOffsetDays)
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const REST_BASE = `${SUPABASE_URL}/rest/v1`
const SERVICE_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
}

function callFn(method: string, token?: string, body?: unknown, params?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  let url = `${BASE}/appointments`
  if (params) {
    const u = new URL(url)
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
    url = u.toString()
  }
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

function createBookingFn(body: unknown) {
  return fetch(`${BASE}/create-booking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify(body),
  })
}

function getAvailabilityFn(params: Record<string, string>) {
  const url = new URL(`${BASE}/get-availability`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return fetch(url.toString(), { method: "GET", headers: { apikey: ANON_KEY } })
}

// Manual bookings are owner-authoritative (no get-availability lookup
// needed) — same helper shape as appointments.test.ts's manualBookingBody.
// Dates 2026-11-10..13, deliberately outside every other *.test.ts file's
// fixture date range (checked against 2026-05/06/07/09/10/12 usage) so
// concurrent CI runs across files never collide on the same slot.
function bookingBody(overrides: Record<string, unknown> = {}) {
  return {
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    service_id: SERVICE_ID,
    staff_profile_id: STAFF_ID,
    date: "2026-11-10",
    time: "10:00",
    duration_minutes: 60,
    price: 50,
    payment_method: "later",
    ...overrides,
  }
}

async function setCapacity(enabled: boolean, count: number | null) {
  const res = await fetch(`${REST_BASE}/business_settings?business_id=eq.${BUSINESS_ID}`, {
    method: "PATCH",
    headers: SERVICE_HEADERS,
    body: JSON.stringify({ seat_capacity_enabled: enabled, seat_count: count }),
  })
  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`Failed to set business_settings capacity: ${res.status} ${await res.text()}`)
  }
  await res.body?.cancel().catch(() => {})
}

// Rows created since `sinceIso` for this business — isolates each test's own
// shadow-log activity instead of asserting exact row identity.
async function shadowLogCountSince(sinceIso: string): Promise<number> {
  const res = await fetch(
    `${REST_BASE}/appointment_capacity_shadow_log?business_id=eq.${BUSINESS_ID}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  )
  const rows = await res.json()
  return Array.isArray(rows) ? rows.length : 0
}

async function setEnforcement(enforced: boolean) {
  const res = await fetch(`${REST_BASE}/business_settings?business_id=eq.${BUSINESS_ID}`, {
    method: "PATCH",
    headers: SERVICE_HEADERS,
    body: JSON.stringify({ seat_capacity_enforced: enforced }),
  })
  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`Failed to set business_settings enforcement: ${res.status} ${await res.text()}`)
  }
  await res.body?.cancel().catch(() => {})
}

async function removeFromPilot(businessId: string) {
  const res = await fetch(`${REST_BASE}/capacity_enforcement_pilot_businesses?business_id=eq.${businessId}`, {
    method: "DELETE",
    headers: SERVICE_HEADERS,
  })
  await res.body?.cancel().catch(() => {})
}

async function addToPilot(businessId: string) {
  const res = await fetch(`${REST_BASE}/capacity_enforcement_pilot_businesses`, {
    method: "POST",
    headers: { ...SERVICE_HEADERS, Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({ business_id: businessId }),
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Failed to add to pilot allowlist: ${res.status} ${await res.text()}`)
  }
  await res.body?.cancel().catch(() => {})
}

// Same isolation approach as shadowLogCountSince, but returns each row's
// `outcome` so Stage 2 tests can distinguish 'logged_only' from 'rejected'.
async function shadowLogRowsSince(sinceIso: string): Promise<{ id: string; outcome: string }[]> {
  const res = await fetch(
    `${REST_BASE}/appointment_capacity_shadow_log?business_id=eq.${BUSINESS_ID}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id,outcome`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  )
  const rows = await res.json()
  return Array.isArray(rows) ? rows : []
}

// 139_owner_conflict_warn_confirm.sql: check_and_reserve_slot's public-path
// branch (p_allow_confirm omitted/false — exactly how create_booking_atomic
// calls it) can no longer be exercised through the owner `appointments`
// endpoint, since that endpoint now always passes p_allow_confirm=true.
// Calling the RPC directly tests that branch in isolation, without needing
// to route a real booking through create-booking's full payment/email
// side effects just to reach the same check.
const RPC_HEADERS = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" }

function checkAndReserveSlotFn(params: Record<string, unknown>) {
  return fetch(`${REST_BASE}/rpc/check_and_reserve_slot`, {
    method: "POST",
    headers: RPC_HEADERS,
    body: JSON.stringify(params),
  })
}

async function getAppointmentInterval(id: string): Promise<{ starts_at: string; ends_at: string }> {
  const res = await fetch(`${REST_BASE}/appointments?id=eq.${id}&select=starts_at,ends_at`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`Expected exactly one appointment row for ${id}, got: ${JSON.stringify(rows)}`)
  }
  return rows[0]
}

async function cancelAppointment(id: string) {
  const res = await fetch(`${REST_BASE}/appointments?id=eq.${id}`, {
    method: "PATCH",
    headers: SERVICE_HEADERS,
    body: JSON.stringify({ status: "cancelled" }),
  })
  if (res.status !== 200 && res.status !== 204) {
    throw new Error(`Failed to cancel fixture appointment: ${res.status} ${await res.text()}`)
  }
  await res.body?.cancel().catch(() => {})
}

// ── 141_cross_business_conflict_visibility.sql fixtures ────────────────────

async function upsertBusinessMember(businessId: string, userId: string): Promise<string> {
  // on_conflict is required: business_members' primary key is `id` (auto-
  // generated, omitted from the payload below), not (business_id, user_id) —
  // without naming that unique constraint explicitly, PostgREST's
  // merge-duplicates has nothing to match against and just 409s on a
  // second call (e.g. this file's second cross-business test re-running
  // the same upsert).
  const res = await fetch(`${REST_BASE}/business_members?on_conflict=business_id,user_id`, {
    method: "POST",
    headers: { ...SERVICE_HEADERS, Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({ business_id: businessId, user_id: userId, role: "staff", is_active: true }),
  })
  if (!res.ok) throw new Error(`Failed to upsert business_member (${businessId}): ${res.status} ${await res.text()}`)
  const rows = await res.json()
  // merge-duplicates on an existing row can return an empty representation
  // depending on PostgREST version — fall back to a plain SELECT.
  if (Array.isArray(rows) && rows[0]?.id) return rows[0].id
  const selectRes = await fetch(
    `${REST_BASE}/business_members?business_id=eq.${businessId}&user_id=eq.${userId}&select=id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  )
  const selected = await selectRes.json()
  if (!Array.isArray(selected) || !selected[0]?.id) {
    throw new Error(`Could not resolve business_member id for (${businessId}, ${userId})`)
  }
  return selected[0].id
}

async function upsertStaffProfile(id: string, businessId: string, businessMemberId: string, displayName: string) {
  const res = await fetch(`${REST_BASE}/staff_profiles`, {
    method: "POST",
    headers: { ...SERVICE_HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      id, business_id: businessId, business_member_id: businessMemberId,
      display_name: displayName, is_active: true,
    }),
  })
  if (!res.ok) throw new Error(`Failed to upsert staff_profile ${id}: ${res.status} ${await res.text()}`)
  await res.body?.cancel().catch(() => {})
}

async function ensureCrossBusinessStaffFixtures(): Promise<void> {
  const bmAfrotouchId = await upsertBusinessMember(BUSINESS_ID, SHARED_PERSON_USER_ID)
  await upsertStaffProfile(XBIZ_AFROTOUCH_STAFF_ID, BUSINESS_ID, bmAfrotouchId, "Cross-Business Test Staff (Afrotouch)")

  const bmForeignId = await upsertBusinessMember(FOREIGN_BUSINESS_ID, SHARED_PERSON_USER_ID)
  await upsertStaffProfile(XBIZ_FOREIGN_STAFF_ID, FOREIGN_BUSINESS_ID, bmForeignId, "Cross-Business Test Staff (Foreign)")
}

async function insertForeignAppointment(startsAtIso: string, endsAtIso: string): Promise<string> {
  const res = await fetch(`${REST_BASE}/appointments`, {
    method: "POST",
    headers: SERVICE_HEADERS,
    body: JSON.stringify({
      business_id: FOREIGN_BUSINESS_ID,
      staff_profile_id: XBIZ_FOREIGN_STAFF_ID,
      starts_at: startsAtIso,
      ends_at: endsAtIso,
      duration_minutes: Math.round((new Date(endsAtIso).getTime() - new Date(startsAtIso).getTime()) / 60000),
      price: 50,
      status: "confirmed",
      booking_reference: `XBIZ-${crypto.randomUUID().slice(0, 8)}`,
    }),
  })
  if (!res.ok) throw new Error(`Failed to insert foreign fixture appointment: ${res.status} ${await res.text()}`)
  const [row] = await res.json()
  return row.id
}

async function getAppointmentStatusAndConflict(
  id: string,
): Promise<{ status: string; cross_business_conflict_appointment_id: string | null }> {
  const res = await fetch(
    `${REST_BASE}/appointments?id=eq.${id}&select=status,cross_business_conflict_appointment_id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  )
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`Expected exactly one appointment row for ${id}, got: ${JSON.stringify(rows)}`)
  }
  return rows[0]
}

// ── Baseline: feature disabled preserves current behaviour ─────────────────

Deno.test("capacity: disabled business — overlapping appointments succeed and log nothing", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(false, null)
  const since = new Date().toISOString()

  const res1 = await callFn("POST", OWNER_TOKEN, bookingBody({
    date: "2026-11-10", time: "09:00", staff_profile_id: STAFF_ID,
  }))
  assertEquals(res1.status, 201)
  await res1.json()

  const res2 = await callFn("POST", OWNER_TOKEN, bookingBody({
    date: "2026-11-10", time: "09:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
  }))
  assertEquals(res2.status, 201)
  await res2.json()

  assertEquals(await shadowLogCountSince(since), 0)
})

// ── Enabled, comfortable capacity — no shadow conflict ──────────────────────

Deno.test("capacity: enabled, capacity=2 — two overlapping staff appointments both fit", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 2)
  const since = new Date().toISOString()

  const res1 = await callFn("POST", OWNER_TOKEN, bookingBody({
    date: "2026-11-11", time: "09:00", staff_profile_id: STAFF_ID,
  }))
  assertEquals(res1.status, 201)
  await res1.json()

  const res2 = await callFn("POST", OWNER_TOKEN, bookingBody({
    date: "2026-11-11", time: "09:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
  }))
  assertEquals(res2.status, 201)
  await res2.json()

  assertEquals(await shadowLogCountSince(since), 0)

  await setCapacity(false, null)
})

// ── Core case: 2 staff available, capacity 1 → the owner-path 2nd
//    overlapping booking now requires confirmation, then succeeds and logs
//    an 'overridden' row (139 superseded Stage 1's silent shadow-log-and-
//    succeed behaviour for the owner path specifically — see the dedicated
//    "owner path" tests below for the fuller assertions on this). ─────────

Deno.test("capacity: enabled, capacity=1 — 2nd overlapping staff appointment on the owner path requires confirmation, then succeeds and logs 'overridden'", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)
  const since = new Date().toISOString()

  try {
    const res1 = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-12", time: "09:00", staff_profile_id: STAFF_ID,
    }))
    assertEquals(res1.status, 201)
    await res1.json()
    // First booking is the only one occupying the interval — must not log.
    assertEquals(await shadowLogCountSince(since), 0)

    const res2 = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-12", time: "09:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
    }))
    assertEquals(res2.status, 409)
    const body2 = await res2.json()
    assertEquals(body2.error.code, "SEAT_CAPACITY_CONFIRM_REQUIRED")

    const res3 = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-12", time: "09:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
      confirm_conflict: true,
    }))
    const res3Body = await res3.json().catch(() => null)
    assertEquals(res3.status, 201, `Expected 201 after confirming, got ${res3.status}: ${JSON.stringify(res3Body)}`)

    const rows = await shadowLogRowsSince(since)
    assertEquals(rows.length, 1)
    assertEquals(rows[0].outcome, "overridden")
  } finally {
    await setCapacity(false, null)
  }
})

// ── A two-staff service still consumes exactly one unit of capacity ────────

Deno.test("capacity: assigning a second staff member to a dual-staff appointment does not add a second capacity unit", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)
  const since = new Date().toISOString()

  // Primary staff only — one appointment, one unit, exactly at the limit.
  const bookRes = await callFn("POST", OWNER_TOKEN, bookingBody({
    date: "2026-11-13", time: "09:00", staff_profile_id: STAFF_ID,
    service_id: DUAL_STAFF_SERVICE_ID, duration_minutes: 60, price: 50,
  }))
  assertEquals(bookRes.status, 201)
  const booked = await bookRes.json()
  assertEquals(await shadowLogCountSince(since), 0)

  // Assigning the second staff member must not push the same appointment's
  // own capacity contribution above the limit — it's still one appointment.
  const assign2Res = await callFn("PATCH", OWNER_TOKEN, { staff_profile_id_2: STAFF_ID_2 }, {
    action: "assign-staff-2",
    id: booked.id,
  })
  assertEquals(assign2Res.status, 200)
  await assign2Res.json()

  assertEquals(await shadowLogCountSince(since), 0)

  await setCapacity(false, null)
})

// ── Cancelled appointments don't count toward capacity ──────────────────────

Deno.test("capacity: a cancelled appointment does not count toward the overlap total", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)

  const res1 = await callFn("POST", OWNER_TOKEN, bookingBody({
    date: "2026-11-10", time: "15:00", staff_profile_id: STAFF_ID,
  }))
  assertEquals(res1.status, 201)
  const booked1 = await res1.json()
  await cancelAppointment(booked1.id)

  const since = new Date().toISOString()
  const res2 = await callFn("POST", OWNER_TOKEN, bookingBody({
    date: "2026-11-10", time: "15:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
  }))
  assertEquals(res2.status, 201)
  await res2.json()

  // The cancelled first appointment must not be counted — this second one
  // is the only live occupant of the interval, so no shadow row.
  assertEquals(await shadowLogCountSince(since), 0)

  await setCapacity(false, null)
})

// ── Reschedule re-evaluates capacity at the NEW interval, not the old one ──

Deno.test("capacity: rescheduling into an already-full interval requires confirmation for the new interval, then succeeds and logs 'overridden'", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)

  try {
    // Appointment A occupies 11:00 on staff1.
    const aRes = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-11", time: "11:00", staff_profile_id: STAFF_ID,
    }))
    assertEquals(aRes.status, 201)
    await aRes.json()

    // Appointment B occupies a disjoint interval (13:00) on staff2 — fits fine.
    const bRes = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-11", time: "13:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
    }))
    assertEquals(bRes.status, 201)
    const booked = await bRes.json()

    const since = new Date().toISOString()

    // Move B into A's interval. The reschedule action always keeps the
    // appointment's existing staff (staff2 here) — it doesn't accept a
    // staff_profile_id override — so this stays a different-staff overlap
    // with no staff-conflict, but now two appointments would occupy 11:00
    // against capacity=1.
    const rescheduleRes = await callFn("PATCH", OWNER_TOKEN, {
      date: "2026-11-11", time: "11:00",
    }, { action: "reschedule", id: booked.id })
    assertEquals(rescheduleRes.status, 409)
    const rescheduleBody = await rescheduleRes.json()
    assertEquals(rescheduleBody.error.code, "SEAT_CAPACITY_CONFIRM_REQUIRED")

    const confirmRes = await callFn("PATCH", OWNER_TOKEN, {
      date: "2026-11-11", time: "11:00", confirm_conflict: true,
    }, { action: "reschedule", id: booked.id })
    const confirmBody = await confirmRes.json().catch(() => null)
    assertEquals(confirmRes.status, 200, `Expected 200 after confirming, got ${confirmRes.status}: ${JSON.stringify(confirmBody)}`)

    const rows = await shadowLogRowsSince(since)
    assertEquals(rows.length, 1)
    assertEquals(rows[0].outcome, "overridden")
  } finally {
    await setCapacity(false, null)
  }
})

// ── Concurrency: two different-staff bookings racing for the last unit of
//    capacity must still serialize through the business-scoped advisory
//    lock — on the owner path this now surfaces as one 201 and one 409
//    (needs confirmation), directly observable via status codes rather than
//    only via the shadow log, proving the lock serialized the two
//    concurrent capacity checks instead of both reading "0 in use". ───────

Deno.test("capacity: two concurrent different-staff bookings for the last unit of capacity — exactly one succeeds, the other needs confirmation", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)

  try {
    const [res1, res2] = await Promise.all([
      callFn("POST", OWNER_TOKEN, bookingBody({
        date: "2026-11-12", time: "16:00", staff_profile_id: STAFF_ID,
      })),
      callFn("POST", OWNER_TOKEN, bookingBody({
        date: "2026-11-12", time: "16:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
      })),
    ])

    // Different staff members, same slot — never a staff conflict either way.
    const statuses = [res1.status, res2.status].sort()
    assertEquals(
      statuses,
      [201, 409],
      `Expected exactly one 201 and one 409, got ${JSON.stringify([res1.status, res2.status])}: ${
        JSON.stringify([await res1.json().catch(() => null), await res2.json().catch(() => null)])
      }`,
    )
    await res1.body?.cancel().catch(() => {})
    await res2.body?.cancel().catch(() => {})
  } finally {
    await setCapacity(false, null)
  }
})

// ── Stage 2 (137_seat_capacity_enforcement.sql): pilot-enforced businesses
//    actually reject over-capacity bookings, gated by THREE independent
//    conditions — seat_capacity_enabled, seat_capacity_enforced, and
//    business_id present in capacity_enforcement_pilot_businesses. Afrotouch
//    is seeded into the pilot table by migration 137 itself.
//
// 139_owner_conflict_warn_confirm.sql superseded this behaviour for the
// OWNER path specifically (it now always warns, regardless of pilot/
// enforced status — see the "owner path" tests further down) — so pilot
// enforcement is only observable on the PUBLIC path now. These two tests
// call check_and_reserve_slot directly with p_allow_confirm omitted
// (exactly how create_booking_atomic calls it) rather than routing through
// the owner `appointments` endpoint, which no longer exercises this branch
// at all. ───────────────────────────────────────────────────────────────

Deno.test("capacity: pilot-enforced business — a 2nd overlapping PUBLIC-path check is rejected (SEAT_CAPACITY_EXCEEDED), not just logged", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)
  await setEnforcement(true)
  const since = new Date().toISOString()

  try {
    // Fixture: one appointment occupies the interval (created via the owner
    // endpoint purely for setup convenience — not itself under test).
    const res1 = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-14", time: "09:00", staff_profile_id: STAFF_ID,
    }))
    assertEquals(res1.status, 201)
    const created1 = await res1.json()
    assertEquals(await shadowLogCountSince(since), 0)
    const interval = await getAppointmentInterval(created1.id)

    // What's actually under test: the public path's own conflict check.
    const checkRes = await checkAndReserveSlotFn({
      p_business_id: BUSINESS_ID,
      p_staff_id: STAFF_ID_2,
      p_starts_at: interval.starts_at,
      p_ends_at: interval.ends_at,
      p_buffer_minutes: 0,
      p_source: "test_public_path",
    })
    if (checkRes.ok) {
      throw new Error(`Expected the public-path check to raise, got ${checkRes.status}: ${await checkRes.text()}`)
    }
    const checkBody = await checkRes.json()
    if (!String(checkBody.message ?? "").includes("SEAT_CAPACITY_EXCEEDED")) {
      throw new Error(`Expected SEAT_CAPACITY_EXCEEDED, got ${checkRes.status}: ${JSON.stringify(checkBody)}`)
    }
    // Not asserted here: the 'rejected' shadow-log row. check_and_reserve_slot
    // no longer writes it directly — the INSERT would be rolled back along
    // with the transaction its RAISE aborts (the same reason 137's
    // seatCapacityLog.ts moved that write to the edge function layer, run
    // AFTER the RPC call returns). Calling the RPC directly here bypasses
    // that layer entirely, so there's nothing to assert on without
    // reimplementing the edge function's own logging inline.
  } finally {
    await setEnforcement(false)
    await setCapacity(false, null)
  }
})

Deno.test("capacity: enforced=true but business NOT in the pilot allowlist — the PUBLIC path still only shadow-logs, never rejects", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)
  await setEnforcement(true)
  await removeFromPilot(BUSINESS_ID)
  const since = new Date().toISOString()

  try {
    const res1 = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-15", time: "09:00", staff_profile_id: STAFF_ID,
    }))
    assertEquals(res1.status, 201)
    const created1 = await res1.json()
    const interval = await getAppointmentInterval(created1.id)

    // Not pilot-enforced — the public path's check succeeds (204) exactly
    // like Stage 1 shadow mode, even though seat_capacity_enforced is true,
    // because the pilot allowlist gate is independent of that flag.
    const checkRes = await checkAndReserveSlotFn({
      p_business_id: BUSINESS_ID,
      p_staff_id: STAFF_ID_2,
      p_starts_at: interval.starts_at,
      p_ends_at: interval.ends_at,
      p_buffer_minutes: 0,
      p_source: "test_public_path",
    })
    if (!checkRes.ok) {
      throw new Error(`Expected the public-path check to succeed, got ${checkRes.status}: ${await checkRes.text()}`)
    }
    await checkRes.body?.cancel().catch(() => {})

    const rows = await shadowLogRowsSince(since)
    assertEquals(rows.length, 1)
    assertEquals(rows[0].outcome, "logged_only")
  } finally {
    // Restore pilot membership — migration 137 seeds this row and every
    // other test in this file assumes it.
    await addToPilot(BUSINESS_ID)
    await setEnforcement(false)
    await setCapacity(false, null)
  }
})

// ── Stage 2: get_available_slots stops offering over-capacity slots ────────
// These two live here (not in get-availability.test.ts) deliberately: Deno
// runs separate test FILES in parallel worker threads by default, and every
// test above mutates the same business_settings capacity columns on this
// same business — putting a capacity-mutating test in a different file
// raced against these and produced a spurious SLOT_TAKEN/
// SEAT_CAPACITY_EXCEEDED on an unrelated fixture booking. Tests within one
// file still run sequentially, so co-locating them here removes the race.

Deno.test("get-availability: pilot-enforced capacity hides an over-capacity slot business-wide, independent of service/staff", async () => {
  await setCapacity(true, 1)
  await setEnforcement(true)
  const date = futureBusinessDate(45)
  try {
    // Fatima's Knotless Braids at 10:00 occupies 10:00-13:00 (180 min).
    const bookRes = await createBookingFn({
      business_id: BUSINESS_ID,
      service_id: SERVICE_ID,
      staff_profile_id: STAFF_ID,
      date,
      time: "10:00",
      client: { name: "Capacity Fixture Client", email: "capacity-fixture-1@test.kazione.local" },
      payment_method: "later",
    })
    assertEquals(bookRes.status, 201, `Expected 201, got ${bookRes.status}: ${JSON.stringify(await bookRes.json().catch(() => null))}`)

    // Regina's Loc Maintenance (120-min, unrelated service AND staff) — at
    // seat_count=1 this single pre-existing appointment already occupies
    // the business's only unit for any interval overlapping 10:00-13:00.
    const res = await getAvailabilityFn({ business_id: BUSINESS_ID, service_id: LOC_MAINTENANCE_SERVICE_ID, date })
    assertEquals(res.status, 200)
    const body = await res.json()
    if (!Array.isArray(body.slots)) throw new Error(`Expected a slots array, got: ${JSON.stringify(body)}`)

    for (const slot of body.slots) {
      if (slot.time < "13:00") {
        throw new Error(
          `Slot ${slot.time} should have been hidden by capacity enforcement (overlaps Fatima's 10:00-13:00 booking), got: ${
            JSON.stringify(body.slots)
          }`,
        )
      }
    }
    // Sanity: capacity filtering must not hide everything — later, non-overlapping slots remain.
    if (!body.slots.some((s: { time: string }) => s.time >= "13:00")) {
      throw new Error(`Expected at least one remaining slot at/after 13:00, got: ${JSON.stringify(body.slots)}`)
    }
  } finally {
    await setEnforcement(false)
    await setCapacity(false, null)
  }
})

Deno.test("get-availability: shadow-only (not enforced) never hides slots, even over the configured seat_count", async () => {
  await setCapacity(true, 1)
  // seat_capacity_enforced intentionally left false (Stage 1 default) —
  // get_available_slots must behave exactly as before 137: no filtering.
  const date = futureBusinessDate(47) // distinct date from the enforced test above
  try {
    const bookRes = await createBookingFn({
      business_id: BUSINESS_ID,
      service_id: SERVICE_ID,
      staff_profile_id: STAFF_ID,
      date,
      time: "10:00",
      client: { name: "Capacity Fixture Client 2", email: "capacity-fixture-2@test.kazione.local" },
      payment_method: "later",
    })
    assertEquals(bookRes.status, 201, `Expected 201, got ${bookRes.status}: ${JSON.stringify(await bookRes.json().catch(() => null))}`)

    const res = await getAvailabilityFn({ business_id: BUSINESS_ID, service_id: LOC_MAINTENANCE_SERVICE_ID, date })
    assertEquals(res.status, 200)
    const body = await res.json()
    if (!Array.isArray(body.slots) || body.slots.length === 0) {
      throw new Error(`Expected Regina's Loc Maintenance slots to be unaffected by shadow-only mode, got: ${JSON.stringify(body)}`)
    }
    // The 10:00-13:00 window must still be offered — shadow mode never filters.
    if (!body.slots.some((s: { time: string }) => s.time === "10:00")) {
      throw new Error(`Expected 10:00 to still be offered in shadow-only mode, got: ${JSON.stringify(body.slots)}`)
    }
  } finally {
    await setCapacity(false, null)
  }
})

// ── 138_seat_capacity_pilot_visibility.sql: owner can read their own row ────

Deno.test("capacity_enforcement_pilot_businesses: the business's own owner can read whether they're pilot-eligible", async () => {
  if (!OWNER_TOKEN) return
  const res = await fetch(
    `${REST_BASE}/capacity_enforcement_pilot_businesses?business_id=eq.${BUSINESS_ID}&select=business_id`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${OWNER_TOKEN}` } },
  )
  assertEquals(res.status, 200)
  const rows = await res.json()
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0].business_id !== BUSINESS_ID) {
    throw new Error(`Expected exactly one row for Afrotouch (seeded by migration 137), got: ${JSON.stringify(rows)}`)
  }
})

// ── 139_owner_conflict_warn_confirm.sql: owner path warns, never blocks ────

Deno.test("capacity: owner path — exceeding the limit returns 409 SEAT_CAPACITY_CONFIRM_REQUIRED, then succeeds with confirm_conflict, logged as 'overridden'", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)
  // Deliberately NOT pilot-enforced (no setEnforcement(true) here) — proves
  // the owner-path warning is driven by seat_capacity_enabled alone,
  // independent of seat_capacity_enforced/the pilot allowlist, which
  // continue to govern only the public hard-block path.
  const since = new Date().toISOString()

  try {
    const res1 = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-16", time: "09:00", staff_profile_id: STAFF_ID,
    }))
    assertEquals(res1.status, 201)
    await res1.json()

    const res2 = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-16", time: "09:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
    }))
    assertEquals(res2.status, 409)
    const body2 = await res2.json()
    assertEquals(body2.error.code, "SEAT_CAPACITY_CONFIRM_REQUIRED")
    assertEquals(body2.error.details?.conflict_type, "seat_capacity")
    assertEquals(body2.error.details?.configured_capacity, 1)
    assertEquals(body2.error.details?.overlapping_count, 1)

    const res3 = await callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-16", time: "09:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
      confirm_conflict: true,
    }))
    const res3Body = await res3.json().catch(() => null)
    assertEquals(res3.status, 201, `Expected 201 after confirming, got ${res3.status}: ${JSON.stringify(res3Body)}`)

    const rows = await shadowLogRowsSince(since)
    assertEquals(rows.length, 1)
    assertEquals(rows[0].outcome, "overridden")
  } finally {
    await setCapacity(false, null)
  }
})

Deno.test("capacity: owner path — staff conflict is warned, not blocked, and confirming it does not also silently need a second seat-capacity confirm when capacity is fine", async () => {
  if (!OWNER_TOKEN) return
  // Capacity disabled entirely — isolates this test to the staff-conflict
  // half of 139, proving it works independently of the capacity feature.
  const slot = bookingBody({ date: "2026-11-17", time: "09:00", staff_profile_id: STAFF_ID })

  const res1 = await callFn("POST", OWNER_TOKEN, slot)
  assertEquals(res1.status, 201)
  await res1.json()

  const res2 = await callFn("POST", OWNER_TOKEN, { ...slot, client_id: CLIENT_ID_2 })
  assertEquals(res2.status, 409)
  const body2 = await res2.json()
  assertEquals(body2.error.code, "STAFF_CONFLICT_CONFIRM_REQUIRED")

  const res3 = await callFn("POST", OWNER_TOKEN, { ...slot, client_id: CLIENT_ID_2, confirm_conflict: true })
  const res3Body = await res3.json().catch(() => null)
  assertEquals(res3.status, 201, `Expected 201 after confirming, got ${res3.status}: ${JSON.stringify(res3Body)}`)
})

// ── 141_cross_business_conflict_visibility.sql ──────────────────────────────
// Lives in this file (not a standalone one) for the same reason the
// get-availability capacity tests do: Deno runs separate test FILES in
// parallel by default, and creating Afrotouch appointments here would race
// against every test above that toggles business_settings' shared capacity
// columns on this same business. Co-locating keeps everything touching
// Afrotouch's write path sequential.

Deno.test("cross-business conflict: booking a staff member already busy at another business succeeds, forces 'offered', and flags the conflict", async () => {
  if (!OWNER_TOKEN) return
  await ensureCrossBusinessStaffFixtures()

  const date = "2026-11-20"
  const time = "10:00"
  const durationMinutes = 180 // Knotless Braids
  const startsAtIso = localWallClockToUtcIso(date, time, "Europe/Tallinn")
  const endsAtIso = new Date(new Date(startsAtIso).getTime() + durationMinutes * 60_000).toISOString()

  // The staff member already has a confirmed appointment at the OTHER
  // business, at the exact interval we're about to book them into at
  // Afrotouch.
  const foreignApptId = await insertForeignAppointment(startsAtIso, endsAtIso)

  const res = await callFn("POST", OWNER_TOKEN, {
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    service_id: SERVICE_ID,
    staff_profile_id: XBIZ_AFROTOUCH_STAFF_ID,
    date, time,
    duration_minutes: durationMinutes,
    price: 120,
    payment_method: "later",
  })
  // Not blocked — 140 removed the hard trigger-level guard.
  const body = await res.json().catch(() => null)
  assertEquals(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(body)}`)

  const row = await getAppointmentStatusAndConflict(body.id)
  assertEquals(row.status, "offered")
  assertEquals(row.cross_business_conflict_appointment_id, foreignApptId)

  // The owner of Afrotouch has no legitimate visibility into the Foreign
  // Test Salon's schedule — the resolved conflict detail must be scrubbed
  // from their view, even though the raw column is set.
  const ownerViewRes = await callFn("GET", OWNER_TOKEN, undefined, { id: body.id })
  assertEquals(ownerViewRes.status, 200)
  const ownerView = await ownerViewRes.json()
  assertEquals(ownerView.cross_business_conflict, null)
})

Deno.test("cross-business conflict: reassigning to a staff member with no conflict clears the flag", async () => {
  if (!OWNER_TOKEN) return
  await ensureCrossBusinessStaffFixtures()

  const date = "2026-11-21"
  const time = "10:00"
  const durationMinutes = 180
  const startsAtIso = localWallClockToUtcIso(date, time, "Europe/Tallinn")
  const endsAtIso = new Date(new Date(startsAtIso).getTime() + durationMinutes * 60_000).toISOString()
  await insertForeignAppointment(startsAtIso, endsAtIso)

  const createRes = await callFn("POST", OWNER_TOKEN, {
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    service_id: SERVICE_ID,
    staff_profile_id: XBIZ_AFROTOUCH_STAFF_ID,
    date, time,
    duration_minutes: durationMinutes,
    price: 120,
    payment_method: "later",
  })
  const created = await createRes.json()
  assertEquals(createRes.status, 201, `Expected 201, got ${createRes.status}: ${JSON.stringify(created)}`)
  const beforeReassign = await getAppointmentStatusAndConflict(created.id)
  assertEquals(beforeReassign.cross_business_conflict_appointment_id !== null, true)

  // Reassign to Fatima (no cross-business link at all) — the stale conflict
  // reference must be cleared, not just left dangling from the old assignment.
  const assignRes = await callFn("PATCH", OWNER_TOKEN, { staff_profile_id: STAFF_ID }, {
    action: "assign-staff",
    id: created.id,
  })
  const assignBody = await assignRes.json().catch(() => null)
  assertEquals(assignRes.status, 200, `Expected 200, got ${assignRes.status}: ${JSON.stringify(assignBody)}`)

  const afterReassign = await getAppointmentStatusAndConflict(created.id)
  assertEquals(afterReassign.cross_business_conflict_appointment_id, null)
})
