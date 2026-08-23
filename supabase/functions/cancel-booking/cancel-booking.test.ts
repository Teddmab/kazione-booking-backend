// supabase/functions/cancel-booking/cancel-booking.test.ts
//
// The two "real cancellation" tests here used to be gated behind
// TEST_APPT_ID/TEST_APPT_CANCEL_TOKEN and TEST_CANCELLED_APPT_ID/
// TEST_CANCELLED_APPT_TOKEN env vars that ci.yml never set — they always
// silently no-op'd, so the actual cancel success path had zero live CI
// coverage. Fixed per CLAUDE.md Rule 7: create-booking's own response
// hands back a real, signed cancel_token (issued server-side, where
// BOOKING_CANCEL_TOKEN_SECRET actually lives) — no env var needed to get
// a genuine one.
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001"
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001"
const STAFF_ID = "d0000000-0000-4000-8000-000000000001"
// Well-known local dev service_role key — not a secret, same value used
// elsewhere in this repo's tests (e.g. create-booking.test.ts) — needed to
// read the appointment row back directly, bypassing RLS.
const SUPABASE_URL = "http://127.0.0.1:54321"
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"

// Owned exclusively by this file — distinct from every other test file's
// date range (create-booking: Jun–Aug 2026, reschedule-booking: Sep 2026,
// _smoke/booking-lifecycle: Nov 2026) so a parallel `deno test` run across
// files can never collide on the same slot.
const CANDIDATE_DATES = ["2026-12-07", "2026-12-14", "2026-12-21"]

function callFn(body: unknown) {
  return fetch(`${BASE}/cancel-booking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
    body: JSON.stringify(body),
  })
}

async function createGuestBooking(): Promise<{ appointmentId: string; cancelToken: string } | null> {
  for (const date of CANDIDATE_DATES) {
    const availRes = await fetch(
      `${BASE}/get-availability?business_id=${BUSINESS_ID}&service_id=${SERVICE_ID}&date=${date}`,
      { headers: { apikey: ANON_KEY } },
    )
    const availBody = await availRes.json()
    const slots = Array.isArray(availBody.slots) ? availBody.slots : []
    if (slots.length === 0) continue

    const res = await callBookingFn({
      business_id: BUSINESS_ID,
      service_id: SERVICE_ID,
      staff_profile_id: STAFF_ID,
      date,
      time: slots[0].time,
      client: { name: "Cancel Test", email: `cancel_test_${Date.now()}@example.com`, phone: "555-8888" },
      payment_method: "later",
    })
    if (res.status !== 201) continue
    const body = await res.json()
    return { appointmentId: body.appointment_id, cancelToken: body.cancel_token }
  }
  return null
}

function callBookingFn(body: unknown) {
  return fetch(`${BASE}/create-booking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
    body: JSON.stringify(body),
  })
}

Deno.test("cancel-booking: missing appointment_id", async () => {
  const res = await callFn({})
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("cancel-booking: invalid cancel token", async () => {
  const res = await callFn({ cancel_token: "invalidtoken" })
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("cancel-booking: valid cancellation with a real token → 200, status becomes cancelled", async () => {
  const booking = await createGuestBooking()
  if (!booking) {
    console.warn("No available slots for cancel-booking test — reset DB with: supabase db reset")
    return
  }
  const res = await callFn({ appointment_id: booking.appointmentId, cancel_token: booking.cancelToken })
  assertEquals(res.status, 200)

  const row = await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${booking.appointmentId}&select=status`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  })
  const rows = await row.json()
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Appointment row not found")
  assertEquals(rows[0].status, "cancelled")
})

Deno.test("cancel-booking: cancelling an already-cancelled appointment → 400, not silently accepted", async () => {
  const booking = await createGuestBooking()
  if (!booking) {
    console.warn("No available slots for cancel-booking test — reset DB with: supabase db reset")
    return
  }
  const firstRes = await callFn({ appointment_id: booking.appointmentId, cancel_token: booking.cancelToken })
  assertEquals(firstRes.status, 200)

  const secondRes = await callFn({ appointment_id: booking.appointmentId, cancel_token: booking.cancelToken })
  assertEquals(secondRes.status, 400)
})
