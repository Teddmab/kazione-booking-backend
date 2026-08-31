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

const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

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

// ── Core case: 2 staff available, capacity 1 → the 2nd overlapping booking
//    still succeeds (shadow mode) but logs a would-exceed row ──────────────

Deno.test("capacity: enabled, capacity=1 — 2nd overlapping staff appointment still succeeds but logs a conflict", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)
  const since = new Date().toISOString()

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
  // Shadow mode: still succeeds even though it exceeds capacity.
  assertEquals(res2.status, 201)
  await res2.json()

  assertEquals(await shadowLogCountSince(since), 1)

  await setCapacity(false, null)
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

Deno.test("capacity: rescheduling into an already-full interval logs a conflict for the new interval, not the old one", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)

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
  // with no staff-conflict, but now two appointments occupy 11:00 against
  // capacity=1.
  const rescheduleRes = await callFn("PATCH", OWNER_TOKEN, {
    date: "2026-11-11", time: "11:00",
  }, { action: "reschedule", id: booked.id })
  assertEquals(rescheduleRes.status, 200)
  await rescheduleRes.json()

  assertEquals(await shadowLogCountSince(since), 1)

  await setCapacity(false, null)
})

// ── Concurrency: two different-staff bookings racing for the last unit of
//    capacity must serialize through the business-scoped advisory lock —
//    both still succeed (shadow mode), but exactly one logs a conflict ─────

Deno.test("capacity: two concurrent different-staff bookings for the last unit of capacity — both succeed, exactly one logs a conflict", async () => {
  if (!OWNER_TOKEN) return
  await setCapacity(true, 1)
  const since = new Date().toISOString()

  const [res1, res2] = await Promise.all([
    callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-12", time: "16:00", staff_profile_id: STAFF_ID,
    })),
    callFn("POST", OWNER_TOKEN, bookingBody({
      date: "2026-11-12", time: "16:00", staff_profile_id: STAFF_ID_2, client_id: CLIENT_ID_2,
    })),
  ])

  // Different staff members, same slot — never a SLOT_TAKEN conflict.
  assertEquals(res1.status, 201, `Expected 201, got ${res1.status}: ${JSON.stringify(await res1.json().catch(() => null))}`)
  assertEquals(res2.status, 201, `Expected 201, got ${res2.status}: ${JSON.stringify(await res2.json().catch(() => null))}`)

  // Whichever call's transaction committed second saw the other's
  // already-committed appointment and exceeded capacity=1 — exactly one
  // shadow row, proving the business-scoped advisory lock serialized the
  // two concurrent capacity checks instead of both reading "0 in use".
  assertEquals(await shadowLogCountSince(since), 1)

  await setCapacity(false, null)
})
