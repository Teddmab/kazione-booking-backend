// supabase/functions/stripe-webhook/stripe-webhook.test.ts
//
// Stripe webhooks cannot be tested end-to-end in local integration tests without
// a real Stripe secret key + signed payloads. Instead, these tests cover:
//   1. Missing stripe-signature header → 400
//   2. Invalid signature → 400
//   3–5. Correct signature with synthetic events → appointment/payment state changes
//
// Tests 3-5 require STRIPE_WEBHOOK_SECRET to be set in the test environment.
// When running locally: npm run dev must be active.

import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const SUPABASE_URL = "http://127.0.0.1:54321"
const SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001"
const SERVICE_ID  = "c0000000-0000-4000-8000-000000000001"
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? ""

// ── helpers ───────────────────────────────────────────────────────────────────

async function supabaseQuery(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
    },
  })
  return res.json()
}

/** Sign a Stripe event payload with HMAC-SHA256 (matches Stripe's format). */
async function signStripePayload(payload: string, secret: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const toSign = `${timestamp}.${payload}`
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(toSign))
  const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("")
  return `t=${timestamp},v1=${hex}`
}

async function createTestBooking(): Promise<{ appointmentId: string; bookingReference: string }> {
  // Find an available slot
  const dates = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]
  let slot: { date: string; time: string; staffId: string } | null = null
  for (const date of dates) {
    const r = await fetch(
      `${BASE}/get-availability?business_id=${BUSINESS_ID}&service_id=${SERVICE_ID}&date=${date}`,
      { headers: { apikey: ANON_KEY } }
    )
    const body = await r.json()
    if (Array.isArray(body.slots) && body.slots.length > 0) {
      const s = body.slots[0]
      slot = { date, time: s.time, staffId: s.staff?.[0]?.id ?? "" }
      break
    }
  }
  if (!slot) throw new Error("No available slots for stripe-webhook test")

  const res = await fetch(`${BASE}/create-booking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
    body: JSON.stringify({
      business_id: BUSINESS_ID,
      service_id: SERVICE_ID,
      staff_profile_id: slot.staffId,
      date: slot.date,
      time: slot.time,
      client: { name: "Stripe Test", email: `stripe_${Date.now()}@example.com`, phone: "555-1111" },
      payment_method: "deposit",
    }),
  })
  const body = await res.json()
  if (res.status !== 201) throw new Error(`Booking failed for stripe test: ${JSON.stringify(body)}`)

  // Inject a fake stripe_payment_intent_id so we can look up the payment
  const fakePI = `pi_test_${Date.now()}`
  await fetch(`${SUPABASE_URL}/rest/v1/payments?appointment_id=eq.${body.appointment_id}`, {
    method: "PATCH",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify({ stripe_payment_intent_id: fakePI }),
  })

  return { appointmentId: body.appointment_id, bookingReference: body.booking_reference }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

Deno.test("stripe-webhook: missing stripe-signature header → 400", async () => {
  const res = await fetch(`${BASE}/stripe-webhook`, {
    method: "POST",
    headers: { "apikey": ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "payment_intent.succeeded" }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("stripe-webhook: invalid signature → 400", async () => {
  const res = await fetch(`${BASE}/stripe-webhook`, {
    method: "POST",
    headers: {
      "apikey": ANON_KEY,
      "Content-Type": "application/json",
      "stripe-signature": "t=1234,v1=invalidsig",
    },
    body: JSON.stringify({ type: "payment_intent.succeeded" }),
  })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("stripe-webhook: payment_intent.succeeded → appointment confirmed, payment paid", async () => {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn("STRIPE_WEBHOOK_SECRET not set — skipping signature-verified test")
    return
  }

  const { appointmentId } = await createTestBooking()

  // Fetch the payment we patched with the fake PI id
  const [paymentRow] = await supabaseQuery(
    `payments?appointment_id=eq.${appointmentId}&select=stripe_payment_intent_id`
  )
  const piId = paymentRow?.stripe_payment_intent_id
  if (!piId) throw new Error("No stripe_payment_intent_id found")

  const event = {
    id: `evt_test_${Date.now()}`,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: piId,
        object: "payment_intent",
        amount: 5000,
        currency: "eur",
        status: "succeeded",
        metadata: { appointment_id: appointmentId },
        latest_charge: null,
      },
    },
  }

  const payload = JSON.stringify(event)
  const sig = await signStripePayload(payload, STRIPE_WEBHOOK_SECRET)

  const res = await fetch(`${BASE}/stripe-webhook`, {
    method: "POST",
    headers: { "apikey": ANON_KEY, "Content-Type": "application/json", "stripe-signature": sig },
    body: payload,
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()

  // Verify DB: appointment confirmed
  const [appt] = await supabaseQuery(`appointments?id=eq.${appointmentId}&select=status`)
  assertEquals(appt?.status, "confirmed")

  // Verify DB: payment paid
  const [pay] = await supabaseQuery(`payments?appointment_id=eq.${appointmentId}&select=status`)
  assertEquals(pay?.status, "paid")
})

Deno.test("stripe-webhook: payment_intent.payment_failed → payment failed, appointment stays pending", async () => {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn("STRIPE_WEBHOOK_SECRET not set — skipping signature-verified test")
    return
  }

  const { appointmentId } = await createTestBooking()
  const [paymentRow] = await supabaseQuery(
    `payments?appointment_id=eq.${appointmentId}&select=stripe_payment_intent_id`
  )
  const piId = paymentRow?.stripe_payment_intent_id
  if (!piId) throw new Error("No stripe_payment_intent_id found")

  const event = {
    id: `evt_test_fail_${Date.now()}`,
    type: "payment_intent.payment_failed",
    data: {
      object: {
        id: piId,
        object: "payment_intent",
        amount: 5000,
        currency: "eur",
        status: "requires_payment_method",
        metadata: { appointment_id: appointmentId },
        last_payment_error: { message: "Card declined" },
      },
    },
  }

  const payload = JSON.stringify(event)
  const sig = await signStripePayload(payload, STRIPE_WEBHOOK_SECRET)

  const res = await fetch(`${BASE}/stripe-webhook`, {
    method: "POST",
    headers: { "apikey": ANON_KEY, "Content-Type": "application/json", "stripe-signature": sig },
    body: payload,
  })
  assertEquals(res.status, 200)
  await res.body?.cancel()

  // Payment status must be failed
  const [pay] = await supabaseQuery(`payments?appointment_id=eq.${appointmentId}&select=status`)
  assertEquals(pay?.status, "failed")

  // Appointment must remain pending (not cancelled)
  const [appt] = await supabaseQuery(`appointments?id=eq.${appointmentId}&select=status`)
  assertEquals(appt?.status, "pending")
})

Deno.test("stripe-webhook: duplicate payment_intent.succeeded → idempotent (no double-confirm)", async () => {
  if (!STRIPE_WEBHOOK_SECRET) {
    console.warn("STRIPE_WEBHOOK_SECRET not set — skipping idempotency test")
    return
  }

  const { appointmentId } = await createTestBooking()
  const [paymentRow] = await supabaseQuery(
    `payments?appointment_id=eq.${appointmentId}&select=stripe_payment_intent_id`
  )
  const piId = paymentRow?.stripe_payment_intent_id ?? `pi_dupe_${Date.now()}`

  const event = {
    id: `evt_dupe_${Date.now()}`,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: piId,
        object: "payment_intent",
        amount: 5000,
        currency: "eur",
        status: "succeeded",
        metadata: { appointment_id: appointmentId },
        latest_charge: null,
      },
    },
  }

  const payload = JSON.stringify(event)

  // Send the same event twice
  for (let i = 0; i < 2; i++) {
    const sig = await signStripePayload(payload, STRIPE_WEBHOOK_SECRET)
    const res = await fetch(`${BASE}/stripe-webhook`, {
      method: "POST",
      headers: { "apikey": ANON_KEY, "Content-Type": "application/json", "stripe-signature": sig },
      body: payload,
    })
    assertEquals(res.status, 200)
    await res.body?.cancel()
  }

  // Exactly one confirmed status — no duplicates in status_log
  const logs = await supabaseQuery(
    `appointment_status_log?appointment_id=eq.${appointmentId}&new_status=eq.confirmed&select=id`
  )
  assertEquals(logs.length, 1, `Expected 1 confirmed log entry, got ${logs.length}`)
})
