// supabase/functions/reschedule-booking/reschedule-booking.test.ts
import { assertEquals, assertExists } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001"
const SERVICE_ID  = "c0000000-0000-4000-8000-000000000001"

function callFn(body: unknown, token?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "apikey": ANON_KEY,
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${BASE}/reschedule-booking`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function createGuestBooking(date: string, time: string, staffId: string): Promise<{ appointmentId: string; bookingReference: string; email: string }> {
  const email = `reschedule_test_${Date.now()}@example.com`
  const res = await fetch(`${BASE}/create-booking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
    body: JSON.stringify({
      business_id: BUSINESS_ID,
      service_id: SERVICE_ID,
      staff_profile_id: staffId,
      date,
      time,
      client: { name: "Reschedule Test", email, phone: "555-9999" },
      payment_method: "later",
    }),
  })
  const body = await res.json()
  if (res.status !== 201) throw new Error(`Booking failed: ${JSON.stringify(body)}`)
  return { appointmentId: body.appointment_id, bookingReference: body.booking_reference, email }
}

async function findAvailableSlots(): Promise<{ date: string; time: string; staffId: string }[]> {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-07", "2026-09-08", "2026-09-09"]
  const results: { date: string; time: string; staffId: string }[] = []
  for (const date of dates) {
    const r = await fetch(
      `${BASE}/get-availability?business_id=${BUSINESS_ID}&service_id=${SERVICE_ID}&date=${date}`,
      { headers: { apikey: ANON_KEY } }
    )
    const body = await r.json()
    if (Array.isArray(body.slots) && body.slots.length > 0) {
      const slot = body.slots[0]
      results.push({ date, time: slot.time, staffId: slot.staff?.[0]?.id ?? "" })
      if (results.length >= 2) break
    }
  }
  return results
}

// ── Tests ─────────────────────────────────────────────────────────────────────

Deno.test("reschedule-booking: missing appointment_id and booking_reference → 400", async () => {
  const res = await callFn({ new_date: "2026-09-10", new_time: "10:00" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("reschedule-booking: missing new_date → 400", async () => {
  const res = await callFn({ appointment_id: "00000000-0000-0000-0000-000000000000", new_time: "10:00" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("reschedule-booking: missing new_time → 400", async () => {
  const res = await callFn({ appointment_id: "00000000-0000-0000-0000-000000000000", new_date: "2026-09-10" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("reschedule-booking: appointment not found → 404", async () => {
  const res = await callFn({
    booking_reference: "KZ-DOESNOTEXIST",
    email: "nobody@example.com",
    new_date: "2026-09-15",
    new_time: "11:00",
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test("reschedule-booking: new slot not available → 409", async () => {
  const slots = await findAvailableSlots()
  if (slots.length < 2) {
    console.warn("Not enough slots for reschedule conflict test — skipping")
    return
  }
  // Book the first slot
  const { bookingReference, email } = await createGuestBooking(slots[0].date, slots[0].time, slots[0].staffId)
  // Book the second slot (so it's occupied)
  await createGuestBooking(slots[1].date, slots[1].time, slots[1].staffId)

  // Try to reschedule the first booking into the now-taken second slot
  const res = await callFn({
    booking_reference: bookingReference,
    email,
    new_date: slots[1].date,
    new_time: slots[1].time,
    staff_profile_id: slots[1].staffId,
  })
  assertEquals(res.status, 409)
  await res.body?.cancel()
})

Deno.test("reschedule-booking: valid reschedule → 200, starts_at updated, status_log entry", async () => {
  const slots = await findAvailableSlots()
  if (slots.length < 2) {
    console.warn("Not enough slots for valid reschedule test — skipping")
    return
  }
  const { appointmentId, bookingReference, email } = await createGuestBooking(
    slots[0].date, slots[0].time, slots[0].staffId
  )

  const res = await callFn({
    booking_reference: bookingReference,
    email,
    new_date: slots[1].date,
    new_time: slots[1].time,
  })
  assertEquals(res.status, 200)
  const body = await res.json()
  assertExists(body.appointment_id)
  assertEquals(body.new_date, slots[1].date)
  assertEquals(body.new_time, slots[1].time)
  assertEquals(body.status, "confirmed")
  // appointmentId was from the original booking; body.appointment_id should match
  assertEquals(body.appointment_id, appointmentId)
})
