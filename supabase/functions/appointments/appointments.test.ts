// supabase/functions/appointments/appointments.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // from seed
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001" // Knotless Braids from seed
const DUAL_STAFF_SERVICE_ID = "c0000000-0000-4000-8000-000000000005" // S58 seed fixture
// confirmed, staff=Fatima (15% personal commission_rate), service defines its
// own 25% commission — seed fixture (see seed.sql "Service with its own
// commission config").
const COMM_TEST_APPT_ID = "f0000000-0000-4000-8000-000000000095"
const STAFF_ID = "d0000000-0000-4000-8000-000000000001" // Fatima K. from seed
const STAFF_ID_2 = "d0000000-0000-4000-8000-000000000002" // Regina M. from seed
const CLIENT_ID = "c1000000-0000-4000-8000-000000000001" // Amara Diallo from seed
const CLIENT_ID_2 = "c1000000-0000-4000-8000-000000000002" // Sophie Martin from seed
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

// Well-known local dev service_role key — not a secret, same value hardcoded
// in create-booking.test.ts. Needed to seed a notification_delivery_log
// fixture directly: RLS only grants owner/manager SELECT on that table, no
// authenticated INSERT (it's append-only from edge functions).
const SUPABASE_URL = "http://127.0.0.1:54321"
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"

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

Deno.test("appointments: complete — commission task uses the service's own commission config, not just the staff's personal rate", async () => {
  if (!OWNER_TOKEN) return

  const res = await callFn("PATCH", OWNER_TOKEN, { status: "completed", payment_method: "cash" }, { id: COMM_TEST_APPT_ID })
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  await res.json()

  // No dedicated read endpoint for owner_tasks — same PostgREST-direct
  // pattern used elsewhere (e.g. staff_action_log in staff.test.ts).
  const restBase = BASE.replace("/functions/v1", "/rest/v1")
  const taskRes = await fetch(
    `${restBase}/owner_tasks?ref_id=eq.${COMM_TEST_APPT_ID}&type=eq.commission_payment&order=created_at.desc&limit=1`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${OWNER_TOKEN}` } },
  )
  assertEquals(taskRes.status, 200)
  const rows = await taskRes.json()
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Expected a commission_payment owner_task for this appointment")
  }
  // Service defines 25% commission on a price-100 appointment → 25.00.
  // Fatima's own commission_rate is 15% — if this asserted 15, the fix
  // that makes the service's commission config take priority regressed.
  assertEquals(rows[0].body.commission_amount, 25)
})

// date_from/date_to are business-local calendar dates, compared against
// starts_at (a true UTC timestamptz). The seed business is Europe/Tallinn
// (UTC+3 in October, pre-DST-end). 01:15 local on 2026-10-06 is 22:15 UTC
// on 2026-10-05 — a wall-clock time whose business-local date and UTC date
// disagree, exactly the boundary a naive `${date}T00:00:00` UTC-string
// comparison gets wrong (it would file this appointment under the 5th, not
// the 6th).
Deno.test("appointments: GET date_from/date_to use the business's local calendar date, not UTC", async () => {
  if (!OWNER_TOKEN) return

  const bookRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({ date: "2026-10-06", time: "01:15" }))
  if (bookRes.status !== 201) {
    const body = await bookRes.json().catch(() => null)
    throw new Error(`Expected 201, got ${bookRes.status}: ${JSON.stringify(body)}`)
  }
  const booked = await bookRes.json()

  const onOct6 = await callFn("GET", OWNER_TOKEN, undefined, {
    business_id: BUSINESS_ID, date_from: "2026-10-06", date_to: "2026-10-06",
  })
  assertEquals(onOct6.status, 200)
  const oct6Body = await onOct6.json()
  const oct6Ids = (oct6Body.appointments ?? []).map((a: { id: string }) => a.id)
  if (!oct6Ids.includes(booked.id)) {
    throw new Error("Expected the 01:15 Tallinn-local Oct 6 appointment to be included when querying date_from/date_to=2026-10-06")
  }

  const onOct5 = await callFn("GET", OWNER_TOKEN, undefined, {
    business_id: BUSINESS_ID, date_from: "2026-10-05", date_to: "2026-10-05",
  })
  assertEquals(onOct5.status, 200)
  const oct5Body = await onOct5.json()
  const oct5Ids = (oct5Body.appointments ?? []).map((a: { id: string }) => a.id)
  if (oct5Ids.includes(booked.id)) {
    throw new Error("The Oct 6 (Tallinn-local) appointment leaked into the Oct 5 query — date filtering regressed to UTC-day semantics")
  }
})

// ── S62: notification-log read endpoint ────────────────────────────────
// "What did we try to send this customer, and did it work" — the concrete
// support use case driving the sprint. Owner/manager only, scoped to one
// appointment via requireOwnerOrManagerCtx (same auth pattern as every
// other business-scoped branch in this file).

Deno.test("appointments: GET ?action=notification-log without appointment_id → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("GET", OWNER_TOKEN, undefined, { action: "notification-log" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("appointments: GET ?action=notification-log for a nonexistent appointment → 404", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("GET", OWNER_TOKEN, undefined, {
    action: "notification-log",
    appointment_id: "f0000000-0000-4000-8000-00000000ffff",
  })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// TEST_ADMIN_TOKEN is a real, authenticated platform admin — but platform
// admin status alone doesn't grant business membership. requireOwnerOrManagerCtx
// rejects it exactly the way it would reject an owner from a different
// business, so this proves the same tenant boundary without needing a
// second fully-seeded business+appointment fixture just for this test.
Deno.test("appointments: GET ?action=notification-log without business membership → 403", async () => {
  const adminToken = Deno.env.get("TEST_ADMIN_TOKEN") || ""
  if (!adminToken) return
  const res = await callFn("GET", adminToken, undefined, {
    action: "notification-log",
    appointment_id: COMM_TEST_APPT_ID,
  })
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

// ── Owner-dashboard reschedule now goes through the same atomic conflict ───
// lock as reschedule-booking/create-booking (previously a plain .update()
// with no re-check — a staff member could be silently double-booked).

Deno.test("appointments: PATCH ?action=reschedule — target slot has a conflict → 409 SLOT_TAKEN", async () => {
  if (!OWNER_TOKEN) return

  // Blocker: Fatima already booked at 10:00 on 2026-10-09.
  const blockerRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-09",
    time: "10:00",
  }))
  assertEquals(blockerRes.status, 201)
  await blockerRes.json()

  // Target: a separate confirmed appointment, also with Fatima, at a
  // different time — rescheduling it into the blocker's slot must conflict.
  const targetRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-09",
    time: "13:00",
    client_id: CLIENT_ID_2,
  }))
  assertEquals(targetRes.status, 201)
  const target = await targetRes.json()

  const rescheduleRes = await callFn("PATCH", OWNER_TOKEN, { date: "2026-10-09", time: "10:00" }, {
    action: "reschedule",
    id: target.id,
  })
  assertEquals(rescheduleRes.status, 409)
  const body = await rescheduleRes.json()
  assertEquals(body.error.code, "SLOT_TAKEN")
})

Deno.test("appointments: PATCH ?action=reschedule — concurrent reschedule into the same free slot → exactly one 200, one 409", async () => {
  if (!OWNER_TOKEN) return

  const targetARes = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-10",
    time: "09:00",
  }))
  assertEquals(targetARes.status, 201)
  const targetA = await targetARes.json()

  const targetBRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({
    date: "2026-10-10",
    time: "11:00",
    client_id: CLIENT_ID_2,
  }))
  assertEquals(targetBRes.status, 201)
  const targetB = await targetBRes.json()

  const [res1, res2] = await Promise.all([
    callFn("PATCH", OWNER_TOKEN, { date: "2026-10-10", time: "15:00" }, { action: "reschedule", id: targetA.id }),
    callFn("PATCH", OWNER_TOKEN, { date: "2026-10-10", time: "15:00" }, { action: "reschedule", id: targetB.id }),
  ])
  const statuses = [res1.status, res2.status].sort()
  assertEquals(statuses[0], 200, `Expected one 200, got statuses ${JSON.stringify(statuses)}`)
  assertEquals(statuses[1], 409, `Expected one 409, got statuses ${JSON.stringify(statuses)}`)
  await res1.body?.cancel().catch(() => {})
  await res2.body?.cancel().catch(() => {})
})

Deno.test("appointments: PATCH ?action=reschedule — cancelled appointment → 400", async () => {
  if (!OWNER_TOKEN) return

  const bookRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({ date: "2026-10-25", time: "09:00" }))
  assertEquals(bookRes.status, 201)
  const booked = await bookRes.json()

  const cancelRes = await callFn("PATCH", OWNER_TOKEN, { status: "cancelled", reason: "test" }, { id: booked.id })
  assertEquals(cancelRes.status, 200)
  await cancelRes.json()

  const rescheduleRes = await callFn("PATCH", OWNER_TOKEN, { date: "2026-10-11", time: "10:00" }, {
    action: "reschedule",
    id: booked.id,
  })
  assertEquals(rescheduleRes.status, 400)
  await rescheduleRes.body?.cancel()
})

// ── Completing an appointment must never silently overwrite a payment the ──
// processor (Stripe/PawaPay) hasn't actually confirmed yet.

Deno.test("appointments: PATCH complete — processor payment still pending → 409, requires confirm_manual_payment", async () => {
  if (!OWNER_TOKEN) return

  const bookRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({ date: "2026-10-12", time: "09:00", price: 80 }))
  assertEquals(bookRes.status, 201)
  const booked = await bookRes.json()

  const restBase = BASE.replace("/functions/v1", "/rest/v1")
  const marker = `pi_test_${Date.now()}`
  const paymentInsertRes = await fetch(`${restBase}/payments`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      business_id: BUSINESS_ID,
      appointment_id: booked.id,
      amount: 80,
      status: "pending",
      method: "card",
      stripe_payment_intent_id: marker,
    }),
  })
  assertEquals(paymentInsertRes.status, 201)

  const blockedRes = await callFn("PATCH", OWNER_TOKEN, { status: "completed" }, { id: booked.id })
  assertEquals(blockedRes.status, 409)
  const blockedBody = await blockedRes.json()
  assertEquals(blockedBody.error.code, "PROCESSOR_PAYMENT_PENDING")

  // The appointment's status must be untouched by the rejected attempt.
  const checkRes = await callFn("GET", OWNER_TOKEN, undefined, { id: booked.id })
  const checkBody = await checkRes.json()
  assertEquals(checkBody.status, "confirmed")

  const overrideRes = await callFn("PATCH", OWNER_TOKEN, { status: "completed", confirm_manual_payment: true, payment_method: "cash" }, { id: booked.id })
  assertEquals(overrideRes.status, 200)
  await overrideRes.json()

  // Two payment rows now exist for this appointment: the placeholder cash
  // row the manual-booking POST always creates when price > 0, and the
  // processor-linked row inserted above — settlement must resolve the
  // *processor-linked* one, not just whichever row PostgREST returns first.
  const paymentCheckRes = await fetch(
    `${restBase}/payments?appointment_id=eq.${booked.id}&stripe_payment_intent_id=eq.${marker}&select=status,notes`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${OWNER_TOKEN}` } },
  )
  const paymentRows = await paymentCheckRes.json()
  if (paymentRows.length !== 1) {
    throw new Error(`Expected exactly one payment row for stripe_payment_intent_id=${marker}, got ${paymentRows.length}`)
  }
  assertEquals(paymentRows[0].status, "paid")
  if (!String(paymentRows[0].notes ?? "").includes("Manually confirmed")) {
    throw new Error(`Expected the manual-override note on the payment row, got: ${paymentRows[0].notes}`)
  }
})

// ── Completion is a compare-and-swap on status — two concurrent completion ─
// requests must not both run payment settlement/stock deduction/commission.

Deno.test("appointments: PATCH complete — concurrent completion of the same appointment → exactly one 200, one 409", async () => {
  if (!OWNER_TOKEN) return

  const bookRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({ date: "2026-10-13", time: "09:00" }))
  assertEquals(bookRes.status, 201)
  const booked = await bookRes.json()

  const [res1, res2] = await Promise.all([
    callFn("PATCH", OWNER_TOKEN, { status: "completed", payment_method: "cash" }, { id: booked.id }),
    callFn("PATCH", OWNER_TOKEN, { status: "completed", payment_method: "cash" }, { id: booked.id }),
  ])
  const statuses = [res1.status, res2.status].sort()
  assertEquals(statuses[0], 200, `Expected one 200, got statuses ${JSON.stringify(statuses)}`)
  assertEquals(statuses[1], 409, `Expected one 409, got statuses ${JSON.stringify(statuses)}`)
  await res1.body?.cancel().catch(() => {})
  await res2.body?.cancel().catch(() => {})
})

Deno.test("appointments: GET ?action=notification-log returns delivery rows for the appointment's owner", async () => {
  if (!OWNER_TOKEN) return

  // Seed a deterministic delivery-log row directly (service role) so this
  // test doesn't depend on a real Resend/MessageBird send having happened
  // somewhere else in the CI run — RESEND_API_KEY isn't provisioned in CI,
  // per CLAUDE.md Rule 7 (hardcoded fixtures over env-gated flakiness).
  const marker = `test-msg-${Date.now()}`
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/notification_delivery_log`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      business_id: BUSINESS_ID,
      appointment_id: COMM_TEST_APPT_ID,
      channel: "email",
      recipient_type: "client",
      purpose: "booking_reminder",
      status: "sent",
      provider_message_id: marker,
    }),
  })
  if (insertRes.status !== 201) {
    throw new Error(`Fixture insert failed: ${insertRes.status} ${await insertRes.text()}`)
  }

  const res = await callFn("GET", OWNER_TOKEN, undefined, {
    action: "notification-log",
    appointment_id: COMM_TEST_APPT_ID,
  })
  assertEquals(res.status, 200)
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error("Expected an array")
  const row = rows.find((r: { provider_message_id: string }) => r.provider_message_id === marker)
  if (!row) throw new Error("Expected the seeded delivery-log row to be returned")
  assertEquals(row.status, "sent")
  assertEquals(row.channel, "email")
  assertEquals(row.recipient_type, "client")
})
// ── SPRINT_S48: commission correction workflow ──────────────────────────────
// Each test books and completes its own fresh appointment (rather than
// reusing COMM_TEST_APPT_ID, which an earlier test already completes) so
// these are independent of file execution order.

async function bookAndComplete(date: string, time: string, overrides: Record<string, unknown> = {}) {
  const bookRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({ date, time, ...overrides }))
  assertEquals(bookRes.status, 201)
  const booked = await bookRes.json()

  const completeRes = await callFn("PATCH", OWNER_TOKEN, { status: "completed", payment_method: "cash" }, { id: booked.id })
  assertEquals(completeRes.status, 200)
  await completeRes.json()

  const getRes = await callFn("GET", OWNER_TOKEN, undefined, { id: booked.id })
  assertEquals(getRes.status, 200)
  const appt = await getRes.json()
  return appt as {
    id: string
    staff_profile_id: string
    commission_amount_snapshot: number
    status_log: { reason: string | null }[]
  }
}

Deno.test("appointments: PATCH ?action=correct-commission — corrects the payable amount without overwriting the snapshot, and logs the change", async () => {
  if (!OWNER_TOKEN) return

  const appt = await bookAndComplete("2026-10-20", "09:00")
  const originalSnapshot = appt.commission_amount_snapshot
  const newAmount = Math.round((originalSnapshot + 10) * 100) / 100

  const correctRes = await callFn("PATCH", OWNER_TOKEN, {
    staff_profile_id: STAFF_ID,
    new_amount: newAmount,
    reason: "Wrong commission rate was configured at completion",
  }, { action: "correct-commission", id: appt.id })
  if (correctRes.status !== 200) {
    throw new Error(`Expected 200, got ${correctRes.status}: ${JSON.stringify(await correctRes.json().catch(() => null))}`)
  }
  const correctBody = await correctRes.json()
  assertEquals(correctBody.adjustment.previous_amount, originalSnapshot)
  assertEquals(correctBody.adjustment.new_amount, newAmount)
  assertEquals(correctBody.current_amount, newAmount)

  const afterRes = await callFn("GET", OWNER_TOKEN, undefined, { id: appt.id })
  const after = await afterRes.json()
  // The original completion-time snapshot must survive the correction untouched.
  assertEquals(after.commission_amount_snapshot, originalSnapshot)
  assertEquals(after.commission_adjustments.length, 1)
  assertEquals(after.commission_adjustments[0].new_amount, newAmount)
  const hasCorrectionLogEntry = (after.status_log as { reason: string | null }[]).some(
    (e) => e.reason?.includes("Commission corrected"),
  )
  if (!hasCorrectionLogEntry) throw new Error("Expected an appointment_status_log entry recording the correction")
})

Deno.test("appointments: PATCH ?action=correct-commission — missing reason → 400", async () => {
  if (!OWNER_TOKEN) return

  const appt = await bookAndComplete("2026-10-21", "09:00")
  const res = await callFn("PATCH", OWNER_TOKEN, {
    staff_profile_id: STAFF_ID,
    new_amount: appt.commission_amount_snapshot + 5,
  }, { action: "correct-commission", id: appt.id })
  assertEquals(res.status, 400)
})

Deno.test("appointments: PATCH ?action=correct-commission — appointment not completed → 400", async () => {
  if (!OWNER_TOKEN) return

  const bookRes = await callFn("POST", OWNER_TOKEN, manualBookingBody({ date: "2026-10-25", time: "09:00" }))
  assertEquals(bookRes.status, 201)
  const booked = await bookRes.json()

  const res = await callFn("PATCH", OWNER_TOKEN, {
    staff_profile_id: STAFF_ID,
    new_amount: 20,
    reason: "Should not be allowed yet",
  }, { action: "correct-commission", id: booked.id })
  assertEquals(res.status, 400)
})

Deno.test("appointments: PATCH ?action=correct-commission — staff_profile_id not assigned to this appointment → 400", async () => {
  if (!OWNER_TOKEN) return

  const appt = await bookAndComplete("2026-10-22", "09:00")
  const res = await callFn("PATCH", OWNER_TOKEN, {
    staff_profile_id: STAFF_ID_2,
    new_amount: 20,
    reason: "Regina was never on this appointment",
  }, { action: "correct-commission", id: appt.id })
  assertEquals(res.status, 400)
})

Deno.test("appointments: PATCH ?action=correct-commission — already paid → 409, commission never silently rewritten", async () => {
  if (!OWNER_TOKEN) return

  const appt = await bookAndComplete("2026-10-23", "09:00")

  const payRes = await callFn("PATCH", OWNER_TOKEN, { pay_method: "cash" }, { action: "mark_commission_paid", id: appt.id })
  assertEquals(payRes.status, 200)
  await payRes.json()

  const res = await callFn("PATCH", OWNER_TOKEN, {
    staff_profile_id: STAFF_ID,
    new_amount: appt.commission_amount_snapshot + 5,
    reason: "Too late — already paid out",
  }, { action: "correct-commission", id: appt.id })
  assertEquals(res.status, 409)
  const body = await res.json()
  assertEquals(body.error.code, "COMMISSION_ALREADY_PAID")
})

Deno.test("appointments: PATCH ?action=correct-commission — new_amount equal to current amount → 400 (no-op rejected)", async () => {
  if (!OWNER_TOKEN) return

  const appt = await bookAndComplete("2026-10-24", "09:00")
  const res = await callFn("PATCH", OWNER_TOKEN, {
    staff_profile_id: STAFF_ID,
    new_amount: appt.commission_amount_snapshot,
    reason: "No actual change",
  }, { action: "correct-commission", id: appt.id })
  assertEquals(res.status, 400)
})

