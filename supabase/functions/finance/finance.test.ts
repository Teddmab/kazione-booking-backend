// supabase/functions/finance/finance.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""
const TEST_BUSINESS_ID = "b0000000-0000-4000-8000-000000000001"
// Fatima K. — the S61 review-seed appointment (f...098, 2026-07-01, rating 4,
// is_public true) is her only public review in this business's seed data.
const TEST_STAFF_ID = "d0000000-0000-4000-8000-000000000001"
// Same seed constants staff.test.ts/appointments.test.ts use for manual bookings.
const TEST_SERVICE_ID = "c0000000-0000-4000-8000-000000000001" // Knotless Braids
const TEST_CLIENT_ID = "c1000000-0000-4000-8000-000000000001" // Amara Diallo

function call(params: Record<string, string>, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const url = new URL(`${BASE}/finance`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return fetch(url.toString(), { headers })
}

// Own /appointments calls for the service-performance test below —
// finance.test.ts otherwise only ever talks to /finance.
function callAppointments(method: string, token?: string, body?: unknown, params?: Record<string, string>) {
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

Deno.test("finance: staff-performance — review_count matches avg_rating's own seeded review", async () => {
  if (!OWNER_TOKEN) return

  const res = await call({
    action: "staff-performance",
    business_id: TEST_BUSINESS_ID,
    from: "2026-07-01",
    to: "2026-07-01",
  }, OWNER_TOKEN)
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error("Expected an array response")

  const row = rows.find((r: Record<string, unknown>) => r.staff_profile_id === TEST_STAFF_ID)
  if (!row) throw new Error(`Expected a row for staff_profile_id ${TEST_STAFF_ID}`)
  assertEquals(row.avg_rating, 4)
  assertEquals(row.review_count, 1)
})

Deno.test("finance: service-performance — bookings/service_value match a fresh completed appointment", async () => {
  if (!OWNER_TOKEN) return

  const bookingRes = await callAppointments("POST", OWNER_TOKEN, {
    business_id: TEST_BUSINESS_ID,
    client_id: TEST_CLIENT_ID,
    service_id: TEST_SERVICE_ID,
    staff_profile_id: TEST_STAFF_ID,
    date: "2027-04-10",
    time: "10:00",
    duration_minutes: 60,
    price: 77,
    payment_method: "later",
  })
  assertEquals(bookingRes.status, 201)
  const booking = await bookingRes.json()

  const completeRes = await callAppointments("PATCH", OWNER_TOKEN, { status: "completed", payment_method: "cash" }, { id: booking.id })
  assertEquals(completeRes.status, 200)

  const res = await call({
    action: "service-performance",
    business_id: TEST_BUSINESS_ID,
    from: "2027-04-10",
    to: "2027-04-10",
  }, OWNER_TOKEN)
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error("Expected an array response")

  const row = rows.find((r: Record<string, unknown>) => r.service_id === TEST_SERVICE_ID)
  if (!row) throw new Error(`Expected a row for service_id ${TEST_SERVICE_ID}`)
  assertEquals(row.bookings, 1)
  assertEquals(row.service_value, 77)
})
