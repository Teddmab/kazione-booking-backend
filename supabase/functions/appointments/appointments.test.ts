// supabase/functions/appointments/appointments.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // from seed
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001" // Knotless Braids from seed
const DUAL_STAFF_SERVICE_ID = "c0000000-0000-4000-8000-000000000005" // S58 seed fixture
const STAFF_ID = "d0000000-0000-4000-8000-000000000001" // Fatima K. from seed
const STAFF_ID_2 = "d0000000-0000-4000-8000-000000000002" // Regina M. from seed
const CLIENT_ID = "c1000000-0000-4000-8000-000000000001" // Amara Diallo from seed
const CLIENT_ID_2 = "c1000000-0000-4000-8000-000000000002" // Sophie Martin from seed
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

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

// Manual bookings (appointments POST) are owner-authoritative — they don't
// go through get-availability, so any future date/time is usable directly.
// date+time are the business's local wall-clock (S59) — Afrotouch (seed
// business) is Europe/Tallinn. S58's own fixed range (2026-10-05 onward),
// distinct from create-booking's (2026-06 to 2026-08) and reschedule-
// booking's (2026-09) test dates, so concurrent CI runs across files never
// collide on the same slot.
function manualBookingBody(overrides: Record<string, unknown> = {}) {
  return {
    business_id: BUSINESS_ID,
    client_id: CLIENT_ID,
    service_id: SERVICE_ID,
    staff_profile_id: STAFF_ID,
    date: "2026-10-05",
    time: "10:00",
    duration_minutes: 60,
    price: 50,
    payment_method: "later",
    ...overrides,
  }
}

Deno.test("appointments: GET without auth", async () => {
  const res = await callFn("GET", undefined, undefined, { business_id: BUSINESS_ID })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("appointments: GET with owner token", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("GET", OWNER_TOKEN, undefined, { business_id: BUSINESS_ID })
  assertEquals(res.status, 200)
})

// ── S58: manual booking creation goes through the same conflict lock as ────
// the online booking flow (create_manual_appointment_atomic, migration 112) ─

Deno.test("appointments: POST without auth", async () => {
  const res = await callFn("POST", undefined, manualBookingBody())
  if (![401, 403].includes(res.status)) throw new Error(`Expected 401 or 403, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("appointments: POST valid manual booking → 201", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-05",
    time: "09:00",
    client_id: CLIENT_ID_2,
  }))
  assertEquals(res.status, 201)
  const body = await res.json()
  if (!body.id) throw new Error("Expected the created appointment's id in the response")
})

Deno.test("appointments: POST manual booking — same staff/slot conflict → 409", async () => {
  if (!OWNER_TOKEN) return
  const slot = manualBookingBody({ date: "2026-10-05", time: "10:00" })

  const res1 = await callFn("POST", OWNER_TOKEN, slot)
  assertEquals(res1.status, 201)
  await res1.json()

  const res2 = await callFn("POST", OWNER_TOKEN, { ...slot, client_id: CLIENT_ID_2 })
  assertEquals(res2.status, 409)
  const body2 = await res2.json()
  assertEquals(body2.error.code, "SLOT_TAKEN")
})

Deno.test("appointments: POST manual booking — concurrent same slot → exactly one 201, one 409", async () => {
  if (!OWNER_TOKEN) return
  const slot = manualBookingBody({ date: "2026-10-05", time: "14:00" })

  const [res1, res2] = await Promise.all([
    callFn("POST", OWNER_TOKEN, slot),
    callFn("POST", OWNER_TOKEN, { ...slot, client_id: CLIENT_ID_2 }),
  ])
  const statuses = [res1.status, res2.status].sort()
  assertEquals(statuses[0], 201, `Expected one 201, got statuses ${JSON.stringify(statuses)}`)
  assertEquals(statuses[1], 409, `Expected one 409, got statuses ${JSON.stringify(statuses)}`)
  await res1.body?.cancel().catch(() => {})
  await res2.body?.cancel().catch(() => {})
})

// ── S58: staff (re)assignment re-checks the target staff member's schedule ─

Deno.test("appointments: PATCH assign-staff — target staff has a conflict → 409", async () => {
  if (!OWNER_TOKEN) return

  // Regina already booked at this time (staff_profile_id = STAFF_ID_2).
  const blockerRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-06",
    time: "10:00",
    staff_profile_id: STAFF_ID_2,
  }))
  assertEquals(blockerRes.status, 201)
  await blockerRes.json()

  // A second, unrelated appointment at the SAME time, currently assigned to
  // Fatima — reassigning it to Regina should conflict with the blocker.
  const targetRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-06",
    time: "10:00",
    staff_profile_id: STAFF_ID,
    client_id: CLIENT_ID_2,
  }))
  assertEquals(targetRes.status, 201)
  const target = await targetRes.json()

  const assignRes = await callFn("PATCH", OWNER_TOKEN, { staff_profile_id: STAFF_ID_2 }, {
    action: "assign-staff",
    id: target.id,
  })
  assertEquals(assignRes.status, 409)
  const assignBody = await assignRes.json()
  assertEquals(assignBody.error.code, "SLOT_TAKEN")
})

// ── S58: secondary (dual-staff) assignment re-checks the target's schedule ─

Deno.test("appointments: PATCH assign-staff-2 — target staff has a conflict → 409", async () => {
  if (!OWNER_TOKEN) return

  // Regina already booked at this time.
  const blockerRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-07",
    time: "10:00",
    staff_profile_id: STAFF_ID_2,
  }))
  assertEquals(blockerRes.status, 201)
  await blockerRes.json()

  // A dual-staff-service appointment at the same time, primary = Fatima —
  // assigning Regina as the secondary should conflict with the blocker.
  const targetRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-07",
    time: "10:00",
    staff_profile_id: STAFF_ID,
    service_id: DUAL_STAFF_SERVICE_ID,
    client_id: CLIENT_ID_2,
  }))
  assertEquals(targetRes.status, 201)
  const target = await targetRes.json()

  const assign2Res = await callFn("PATCH", OWNER_TOKEN, { staff_profile_id_2: STAFF_ID_2 }, {
    action: "assign-staff-2",
    id: target.id,
  })
  assertEquals(assign2Res.status, 409)
  const assign2Body = await assign2Res.json()
  assertEquals(assign2Body.error.code, "SLOT_TAKEN")
})

Deno.test("appointments: PATCH assign-staff-2 — clearing the assignment never conflicts", async () => {
  if (!OWNER_TOKEN) return

  const targetRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-08",
    time: "10:00",
    staff_profile_id: STAFF_ID,
    service_id: DUAL_STAFF_SERVICE_ID,
  }))
  assertEquals(targetRes.status, 201)
  const target = await targetRes.json()

  const clearRes = await callFn("PATCH", OWNER_TOKEN, { staff_profile_id_2: null }, {
    action: "assign-staff-2",
    id: target.id,
  })
  assertEquals(clearRes.status, 200)
})

// The following require more setup for date filter
// Deno.test("appointments: GET with date filter", async () => { ... })
