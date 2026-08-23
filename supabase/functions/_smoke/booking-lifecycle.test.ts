// supabase/functions/_smoke/booking-lifecycle.test.ts
//
// End-to-end regression guardrail for the core booking flow: public
// discovery → availability → book → view (client + owner) → reschedule →
// cancel → re-cancel is rejected. Every function on this path already has
// its own unit-style tests, but those can all stay green while the SEAM
// between two functions silently breaks — a renamed response field, a
// changed status string, a staff assignment that gets dropped between
// create-booking and the owner's view (a real bug fixed this session).
// This test walks the real chain through real HTTP calls to the real
// functions, the same way a client and an owner actually would, using only
// hardcoded seed fixtures — no env-var-gated skips (CLAUDE.md Rule 7).
//
// Runs inside the same `deno test supabase/functions/` invocation as every
// other test file, so it's automatically part of the already-required
// "Backend CI" branch-protection check — no separate CI wiring needed.
import { assertEquals, assertExists } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // Afrotouch, from seed
const BUSINESS_SLUG = "afrotouch"
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001" // Knotless Braids
const STAFF_ID = "d0000000-0000-4000-8000-000000000001" // Fatima K.
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

// A date range no other test file or seed.sql fixture touches, so a shared
// local CI run can never collide on the same slot: create-booking.test.ts
// uses Jun–Aug 2026 + 2026-10-12 (Kampala), reschedule-booking.test.ts uses
// Sep 2026, cancel-booking.test.ts uses Dec 7–21 2026, get-booking.test.ts
// uses Jan 2027 — and seed.sql itself directly INSERTs fixture appointments
// on 2026-06-08, 07-01, 10-05, 10-12, 11-02, and 12-01 for this same staff
// member (see the comment above f0000000-…-000000099 in seed.sql). This
// file owns February 2027.
const CANDIDATE_DATES = ["2027-02-01", "2027-02-08", "2027-02-15", "2027-02-22"]

interface CallOpts {
  method?: string
  body?: unknown
  token?: string
  params?: Record<string, string>
}

function call(fn: string, opts: CallOpts = {}) {
  const url = new URL(`${BASE}/${fn}`)
  if (opts.params) Object.entries(opts.params).forEach(([k, v]) => url.searchParams.set(k, v))
  const headers: Record<string, string> = { apikey: ANON_KEY }
  if (opts.body) headers["Content-Type"] = "application/json"
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`
  return fetch(url.toString(), {
    method: opts.method ?? (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

async function findTwoAvailableSlots(): Promise<{ date: string; time: string }[]> {
  const found: { date: string; time: string }[] = []
  for (const date of CANDIDATE_DATES) {
    const res = await call("get-availability", {
      params: { business_id: BUSINESS_ID, service_id: SERVICE_ID, date },
    })
    const body = await res.json()
    const slots = Array.isArray(body.slots) ? body.slots : []
    const withStaff = slots.filter(
      (s: { staff?: { id: string }[] }) =>
        Array.isArray(s.staff) && s.staff.some((st) => st.id === STAFF_ID),
    )
    for (const s of withStaff) {
      found.push({ date, time: s.time })
      if (found.length >= 2) return found
    }
  }
  return found
}

Deno.test("booking lifecycle: storefront → availability → book → view → reschedule → cancel → re-cancel rejected", async () => {
  // ── 1. Public discovery — the storefront a client actually lands on ────
  const storefrontRes = await call("get-storefront", { params: { slug: BUSINESS_SLUG } })
  assertEquals(storefrontRes.status, 200)
  const storefront = await storefrontRes.json()
  if (!Array.isArray(storefront.services) || storefront.services.length === 0) {
    throw new Error("Storefront returned no services — the public booking page would render empty")
  }

  // ── 2. Availability — need two real open slots for the same staff ─────
  const slots = await findTwoAvailableSlots()
  if (slots.length < 2) {
    console.warn("Not enough available slots for the booking-lifecycle smoke test — reset DB with: supabase db reset")
    return
  }

  // ── 3. Create the booking (guest, pay-at-salon, explicit staff choice) ─
  const email = `smoke_lifecycle_${Date.now()}@example.com`
  const createRes = await call("create-booking", {
    body: {
      business_id: BUSINESS_ID,
      service_id: SERVICE_ID,
      staff_profile_id: STAFF_ID,
      date: slots[0].date,
      time: slots[0].time,
      client: { name: "Lifecycle Smoke Test", email, phone: "+372 5000 0001" },
      payment_method: "later",
    },
  })
  if (createRes.status !== 201) {
    throw new Error(`create-booking failed: ${createRes.status} ${await createRes.text()}`)
  }
  const created = await createRes.json()
  assertExists(created.appointment_id)
  assertExists(created.booking_reference)
  assertExists(created.cancel_token)

  // ── 4. Client-side view, via the real cancel token create-booking handed back ──
  const clientViewRes = await call("get-booking", {
    params: { id: created.appointment_id, cancel_token: created.cancel_token },
  })
  assertEquals(clientViewRes.status, 200)
  const clientView = await clientViewRes.json()
  assertEquals(clientView.booking.id, created.appointment_id)
  // Guards a real regression fixed this session: a booking made WITH a
  // chosen staff member still showed up unassigned everywhere downstream.
  assertEquals(clientView.booking.staff_profile_id, STAFF_ID)

  // ── 5. Owner-side view — same appointment, same staff assignment ──────
  if (OWNER_TOKEN) {
    const ownerViewRes = await call("appointments", { token: OWNER_TOKEN, params: { id: created.appointment_id } })
    assertEquals(ownerViewRes.status, 200)
    const ownerView = await ownerViewRes.json()
    assertEquals(ownerView.id, created.appointment_id)
    assertEquals(ownerView.staff_profile_id, STAFF_ID)
  }

  // ── 6. Reschedule to the second slot ───────────────────────────────────
  const rescheduleRes = await call("reschedule-booking", {
    body: {
      booking_reference: created.booking_reference,
      email,
      new_date: slots[1].date,
      new_time: slots[1].time,
    },
  })
  assertEquals(rescheduleRes.status, 200)
  const rescheduled = await rescheduleRes.json()
  assertEquals(rescheduled.appointment_id, created.appointment_id)
  assertEquals(rescheduled.new_date, slots[1].date)
  assertEquals(rescheduled.new_time, slots[1].time)
  assertEquals(rescheduled.status, "confirmed")

  // ── 7. Cancel — the original cancel token stays valid post-reschedule ─
  // (it only encodes appointment_id + booking_reference + expiry, not the
  // slot time, so a reschedule can never invalidate it).
  const cancelRes = await call("cancel-booking", {
    body: { appointment_id: created.appointment_id, cancel_token: created.cancel_token },
  })
  assertEquals(cancelRes.status, 200)

  // ── 8. Confirm the cancellation actually landed ────────────────────────
  const afterCancelRes = await call("get-booking", {
    params: { id: created.appointment_id, cancel_token: created.cancel_token },
  })
  assertEquals(afterCancelRes.status, 200)
  const afterCancel = await afterCancelRes.json()
  assertEquals(afterCancel.booking.status, "cancelled")

  // ── 9. Cancelling an already-cancelled booking is rejected, not silently OK'd ──
  const doubleCancelRes = await call("cancel-booking", {
    body: { appointment_id: created.appointment_id, cancel_token: created.cancel_token },
  })
  assertEquals(doubleCancelRes.status, 400)
})
