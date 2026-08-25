// supabase/functions/staff/staff.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""
// Seed fixture (supabase/seed.sql) — Fatima K., an active staff profile on
// Afrotouch Tallinn. Hardcoded (deterministic seed data, not a secret) so
// the magic-link audit test below actually runs in CI instead of silently
// skipping behind an unset env var (S74).
const TEST_STAFF_ID = "d0000000-0000-4000-8000-000000000001"
const TEST_BUSINESS_ID = "b0000000-0000-4000-8000-000000000001"
// Same seed constants appointments.test.ts uses for manual bookings.
const TEST_SERVICE_ID = "c0000000-0000-4000-8000-000000000001" // Knotless Braids
const TEST_CLIENT_ID = "c1000000-0000-4000-8000-000000000001" // Amara Diallo

function call(method: string, token?: string, body?: unknown, params?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  let url = `${BASE}/staff`
  if (params) {
    const u = new URL(url)
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
    url = u.toString()
  }
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

// Own /appointments calls for the pay-commissions fixture below — staff.test.ts
// otherwise only ever talks to /staff.
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

// Own /services calls for the commission-snapshot regression below.
function callServices(method: string, token?: string, body?: unknown, params?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  let url = `${BASE}/services`
  if (params) {
    const u = new URL(url)
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
    url = u.toString()
  }
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

// ── GET /staff ────────────────────────────────────────────────────────────────

Deno.test("staff: GET without auth → 401 or 403", async () => {
  const res = await call("GET")
  if (![401, 403].includes(res.status)) throw new Error(`Expected 401 or 403, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("staff: GET with owner token → 200 array", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("GET", OWNER_TOKEN)
  assertEquals(res.status, 200)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error("Expected array response")
})

// ── POST /staff (invite) ──────────────────────────────────────────────────────

Deno.test("staff: POST without auth → 401 or 403", async () => {
  const res = await call("POST", undefined, { name: "Test Staff", email: "test@example.com", role: "staff" })
  if (![401, 403].includes(res.status)) throw new Error(`Expected 401 or 403, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("staff: POST missing name → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("POST", OWNER_TOKEN, { email: "test@example.com", role: "staff" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("staff: POST invalid email → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("POST", OWNER_TOKEN, { name: "Test Staff", email: "not-an-email", role: "staff" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("staff: POST invalid role → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("POST", OWNER_TOKEN, { name: "Test Staff", email: "valid@example.com", role: "superadmin" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

// ── PATCH /staff?id= ──────────────────────────────────────────────────────────

Deno.test("staff: PATCH without id → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("PATCH", OWNER_TOKEN, { display_name: "Updated" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("staff: PATCH non-existent id → 404", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("PATCH", OWNER_TOKEN, { display_name: "Updated" }, { id: "00000000-0000-0000-0000-000000000000" })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test("staff: PATCH no fields provided → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await fetch(`${BASE}/staff?id=00000000-0000-0000-0000-000000000001`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY, "Authorization": `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify({}),
  })
  if (![400, 404].includes(res.status)) throw new Error(`Expected 400 or 404, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("staff: PATCH is_supervisor — owner can promote and demote a staff member", async () => {
  if (!OWNER_TOKEN) return

  const promote = await call("PATCH", OWNER_TOKEN, { is_supervisor: true }, { id: TEST_STAFF_ID })
  if (promote.status !== 200) {
    const body = await promote.json().catch(() => null)
    throw new Error(`Expected 200, got ${promote.status}: ${JSON.stringify(body)}`)
  }
  const promoted = await promote.json()
  assertEquals(promoted.is_supervisor, true)

  try {
    // Booking notifications must pick up the newly-promoted supervisor —
    // read back via PostgREST rather than re-deriving the query, so this
    // actually exercises the stored column the notification helper reads.
    const restBase = BASE.replace("/functions/v1", "/rest/v1")
    const check = await fetch(
      `${restBase}/staff_profiles?id=eq.${TEST_STAFF_ID}&select=is_supervisor`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${OWNER_TOKEN}` } },
    )
    assertEquals(check.status, 200)
    const rows = await check.json()
    assertEquals(Array.isArray(rows) && rows.length === 1 && rows[0].is_supervisor, true)
  } finally {
    // Reset so this fixture doesn't leak supervisor status into other tests.
    const demote = await call("PATCH", OWNER_TOKEN, { is_supervisor: false }, { id: TEST_STAFF_ID })
    assertEquals(demote.status, 200)
    const demoted = await demote.json()
    assertEquals(demoted.is_supervisor, false)
  }
})

// ── PUT ?action=schedule ──────────────────────────────────────────────────────

Deno.test("staff: PUT schedule without id → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("PUT", OWNER_TOKEN, [], { action: "schedule" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("staff: PUT schedule invalid day_of_week → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await fetch(`${BASE}/staff?action=schedule&id=00000000-0000-0000-0000-000000000001`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY, "Authorization": `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify([{ day_of_week: 9, is_working: true, start_time: "09:00", end_time: "17:00" }]),
  })
  if (![400, 404].includes(res.status)) throw new Error(`Expected 400 or 404, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("staff: PUT schedule start_time >= end_time → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await fetch(`${BASE}/staff?action=schedule&id=00000000-0000-0000-0000-000000000001`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY, "Authorization": `Bearer ${OWNER_TOKEN}` },
    body: JSON.stringify([{ day_of_week: 1, is_working: true, start_time: "17:00", end_time: "09:00" }]),
  })
  if (![400, 404].includes(res.status)) throw new Error(`Expected 400 or 404, got ${res.status}`)
  await res.body?.cancel()
})

// ── DELETE /staff?id= ─────────────────────────────────────────────────────────

Deno.test("staff: DELETE without id → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("DELETE", OWNER_TOKEN)
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("staff: DELETE non-existent id → 404", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("DELETE", OWNER_TOKEN, undefined, { id: "00000000-0000-0000-0000-000000000000" })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── GET ?action=services ──────────────────────────────────────────────────────

Deno.test("staff: GET services without id → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("GET", OWNER_TOKEN, undefined, { action: "services" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("staff: GET services non-existent id → 404", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("GET", OWNER_TOKEN, undefined, { action: "services", id: "00000000-0000-0000-0000-000000000000" })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── PATCH ?action=assign-services ────────────────────────────────────────────

Deno.test("staff: PATCH assign-services without id → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("PATCH", OWNER_TOKEN, { service_ids: [] }, { action: "assign-services" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("staff: PATCH assign-services missing service_ids → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("PATCH", OWNER_TOKEN, {}, { action: "assign-services", id: "00000000-0000-0000-0000-000000000001" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("staff: PATCH assign-services invalid service_ids → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("PATCH", OWNER_TOKEN, { service_ids: ["not-a-real-uuid"] }, { action: "assign-services", id: "00000000-0000-0000-0000-000000000001" })
  // 400 (invalid UUIDs) or 404 (staff not found under this business)
  if (![400, 404].includes(res.status)) throw new Error(`Expected 400 or 404, got ${res.status}`)
  await res.body?.cancel()
})

// ── GET /staff?action=magic-link — S57 finding 6: audit trail + staff notification ──

Deno.test("staff: GET magic-link without auth → 401 or 403", async () => {
  const res = await call("GET", undefined, undefined, { action: "magic-link", staff_profile_id: "00000000-0000-0000-0000-000000000001" })
  if (![401, 403].includes(res.status)) throw new Error(`Expected 401 or 403, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("staff: GET magic-link missing staff_profile_id → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("GET", OWNER_TOKEN, undefined, { action: "magic-link" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("staff: GET magic-link — valid request writes a staff_action_log row and returns a link", async () => {
  if (!OWNER_TOKEN) return

  // Diagnostic: confirm the seed fixture itself exists and is active before
  // blaming the handler for a 404 — makes a future failure here
  // self-explanatory instead of an opaque status mismatch.
  const restBase = BASE.replace("/functions/v1", "/rest/v1")
  const seedCheckRes = await fetch(
    `${restBase}/staff_profiles?id=eq.${TEST_STAFF_ID}&select=id,business_id,is_active,display_name`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${OWNER_TOKEN}` } },
  )
  const seedRows = await seedCheckRes.json()
  if (!Array.isArray(seedRows) || seedRows.length === 0) {
    throw new Error(
      `Seed fixture missing: no staff_profiles row with id=${TEST_STAFF_ID}. ` +
      `(PostgREST status ${seedCheckRes.status}, body: ${JSON.stringify(seedRows)}) ` +
      `Expected this to come from migration 014_seed_data.sql ("Fatima K."). ` +
      `If this fires, the fixture itself needs investigating — not the magic-link handler.`,
    )
  }

  const res = await call("GET", OWNER_TOKEN, undefined, {
    action: "magic-link",
    staff_profile_id: TEST_STAFF_ID,
    business_id: TEST_BUSINESS_ID,
  })
  if (res.status !== 200) {
    const errBody = await res.json().catch(() => null)
    throw new Error(
      `Expected 200, got ${res.status}. Seed row found: ${JSON.stringify(seedRows[0])}. ` +
      `Response body: ${JSON.stringify(errBody)}`,
    )
  }
  const body = await res.json()
  // Set via seed.sql (S74) — Fatima K.'s profile has no linked
  // business_member_id, so this comes from her invited_email fallback.
  assertEquals(body.email, "fatima.k@test.kazione.local")

  // Verify the audit trail directly via PostgREST (no dedicated read endpoint
  // exists for staff_action_log yet — RLS lets an owner/manager read their
  // own business's rows). Reuses restBase from the diagnostic check above.
  //
  // logStaffAction is fire-and-forget (never awaited by the handler, by
  // design), so the row can land a beat after the HTTP response does. Poll
  // briefly instead of a single immediate query.
  let rows: unknown[] = []
  for (let attempt = 0; attempt < 10 && rows.length === 0; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 200))
    const logRes = await fetch(
      `${restBase}/staff_action_log?staff_profile_id=eq.${TEST_STAFF_ID}&action=eq.STAFF_MAGIC_LINK_ISSUED&order=created_at.desc&limit=1`,
      { headers: { apikey: ANON_KEY, Authorization: `Bearer ${OWNER_TOKEN}` } },
    )
    assertEquals(logRes.status, 200)
    rows = await logRes.json()
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Expected a STAFF_MAGIC_LINK_ISSUED row in staff_action_log for this staff_profile_id")
  }
})

// ── PATCH ?action=pay-commissions — payment metadata (S — Compensation redesign) ─

Deno.test("staff: pay-commissions — records payment_date/reference/note and they round-trip via the ledger", async () => {
  if (!OWNER_TOKEN) return

  // Fresh booking each run (own date range, distinct from every other test
  // file's reserved slots) so this test never collides with — or depends
  // on the paid/unpaid state left behind by — any other test's fixtures.
  const bookingRes = await callAppointments("POST", OWNER_TOKEN, {
    business_id: TEST_BUSINESS_ID,
    client_id: TEST_CLIENT_ID,
    service_id: TEST_SERVICE_ID,
    staff_profile_id: TEST_STAFF_ID,
    date: "2026-11-05",
    time: "11:00",
    duration_minutes: 60,
    price: 50,
    payment_method: "later",
  })
  assertEquals(bookingRes.status, 201)
  const booking = await bookingRes.json()

  const completeRes = await callAppointments("PATCH", OWNER_TOKEN, { status: "completed", payment_method: "cash" }, { id: booking.id })
  assertEquals(completeRes.status, 200)

  const payRes = await call("PATCH", OWNER_TOKEN, {
    business_id: TEST_BUSINESS_ID,
    payments: [{ appointment_id: booking.id, amount: 12.5 }],
    pay_method: "bank_transfer",
    payment_date: "2026-11-06",
    reference: "TX-TEST-001",
    note: "Paid via test suite",
  }, { action: "pay-commissions" })
  if (payRes.status !== 200) {
    const errBody = await payRes.json().catch(() => null)
    throw new Error(`Expected 200, got ${payRes.status}: ${JSON.stringify(errBody)}`)
  }
  const payBody = await payRes.json()
  assertEquals(payBody.paid_count, 1)

  const ledgerRes = await call("GET", OWNER_TOKEN, undefined, { action: "commissions", staff_id: TEST_STAFF_ID, status: "all" })
  assertEquals(ledgerRes.status, 200)
  const ledger = await ledgerRes.json()
  const row = (ledger.commissions as Array<Record<string, unknown>>).find((c) => c.appointment_id === booking.id)
  if (!row) throw new Error(`Expected to find appointment ${booking.id} in the commissions ledger`)
  assertEquals(row.commission_amount_paid, 12.5)
  assertEquals(row.commission_payment_date, "2026-11-06")
  assertEquals(row.commission_pay_reference, "TX-TEST-001")
  assertEquals(row.commission_pay_note, "Paid via test suite")
})

// ── time-off (Availability tab — Vacation exception type) ──────────────────────

Deno.test("staff: time-off — create, list within window, then delete round-trips cleanly", async () => {
  if (!OWNER_TOKEN) return

  const createRes = await call("POST", OWNER_TOKEN, {
    date_from: "2027-02-10",
    date_to: "2027-02-12",
    reason: "Test vacation",
  }, { action: "time-off", id: TEST_STAFF_ID })
  if (createRes.status !== 201) {
    const errBody = await createRes.json().catch(() => null)
    throw new Error(`Expected 201, got ${createRes.status}: ${JSON.stringify(errBody)}`)
  }
  const created = await createRes.json()
  assertEquals(created.reason, "Test vacation")
  // starts_at/ends_at are UTC-midnight day boundaries, exclusive on the end —
  // same convention get_available_slots already enforces against this table.
  assertEquals(created.starts_at.startsWith("2027-02-10"), true)
  assertEquals(created.ends_at.startsWith("2027-02-13"), true)

  const listRes = await call("GET", OWNER_TOKEN, undefined, {
    action: "time-off", id: TEST_STAFF_ID, from: "2027-02-01", to: "2027-02-28",
  })
  assertEquals(listRes.status, 200)
  const list = await listRes.json()
  if (!Array.isArray(list) || !list.some((r: Record<string, unknown>) => r.id === created.id)) {
    throw new Error(`Expected the created time-off row ${created.id} to appear in the February listing`)
  }

  // A window entirely outside the range shouldn't return it.
  const outsideRes = await call("GET", OWNER_TOKEN, undefined, {
    action: "time-off", id: TEST_STAFF_ID, from: "2027-03-01", to: "2027-03-31",
  })
  assertEquals(outsideRes.status, 200)
  const outsideList = await outsideRes.json()
  if (outsideList.some((r: Record<string, unknown>) => r.id === created.id)) {
    throw new Error("Did not expect the February time-off row to appear in a March window")
  }

  const deleteRes = await call("DELETE", OWNER_TOKEN, undefined, {
    action: "time-off", id: TEST_STAFF_ID, off_id: created.id,
  })
  assertEquals(deleteRes.status, 200)

  const afterDeleteRes = await call("GET", OWNER_TOKEN, undefined, {
    action: "time-off", id: TEST_STAFF_ID, from: "2027-02-01", to: "2027-02-28",
  })
  const afterDeleteList = await afterDeleteRes.json()
  if (afterDeleteList.some((r: Record<string, unknown>) => r.id === created.id)) {
    throw new Error("Expected the time-off row to be gone after delete")
  }
})

// ── commission completion snapshot (financial-integrity fix) ───────────────────

Deno.test("staff: commissions — a completed appointment's commission is frozen at completion, not recalculated when the service's rate later changes", async () => {
  if (!OWNER_TOKEN) return

  // Capture the service's current commission config so it can be restored —
  // this seeded service is shared with other tests/seed data, and this test
  // must not leave it mutated.
  const listRes = await callServices("GET", OWNER_TOKEN, undefined, { business_id: TEST_BUSINESS_ID })
  assertEquals(listRes.status, 200)
  const services = await listRes.json()
  const original = (services as Array<Record<string, unknown>>).find((s) => s.id === TEST_SERVICE_ID)
  if (!original) throw new Error(`Expected to find service ${TEST_SERVICE_ID} in the services list`)
  const originalType = original.staff_commission_type
  const originalValue = original.staff_commission_value

  try {
    // 1. Set a known rate (R1 = 10%) before booking.
    const setR1Res = await callServices("PATCH", OWNER_TOKEN, { staff_commission_type: "percentage", staff_commission_value: 10 }, { id: TEST_SERVICE_ID })
    assertEquals(setR1Res.status, 200)

    // 2. Book and complete an appointment under R1 — price 100 * 10% = 10.
    const bookingRes = await callAppointments("POST", OWNER_TOKEN, {
      business_id: TEST_BUSINESS_ID,
      client_id: TEST_CLIENT_ID,
      service_id: TEST_SERVICE_ID,
      staff_profile_id: TEST_STAFF_ID,
      date: "2027-03-15",
      time: "11:00",
      duration_minutes: 60,
      price: 100,
      payment_method: "later",
    })
    assertEquals(bookingRes.status, 201)
    const booking = await bookingRes.json()

    const completeRes = await callAppointments("PATCH", OWNER_TOKEN, { status: "completed", payment_method: "cash" }, { id: booking.id })
    assertEquals(completeRes.status, 200)

    const ledgerBefore = await call("GET", OWNER_TOKEN, undefined, { action: "commissions", staff_id: TEST_STAFF_ID, status: "all" })
    assertEquals(ledgerBefore.status, 200)
    const rowBefore = ((await ledgerBefore.json()).commissions as Array<Record<string, unknown>>).find((c) => c.appointment_id === booking.id)
    if (!rowBefore) throw new Error(`Expected to find appointment ${booking.id} in the commissions ledger`)
    assertEquals(rowBefore.commission_amount, 10)

    // 3. Change the service's rate to R2 (25%) — a real owner edit, same
    // endpoint the new "Edit commission rule" sheet uses.
    const setR2Res = await callServices("PATCH", OWNER_TOKEN, { staff_commission_type: "percentage", staff_commission_value: 25 }, { id: TEST_SERVICE_ID })
    assertEquals(setR2Res.status, 200)

    // 4. Re-fetch the SAME already-completed appointment's ledger row — it
    // must still show the R1 amount, not silently recalculate to R2.
    const ledgerAfter = await call("GET", OWNER_TOKEN, undefined, { action: "commissions", staff_id: TEST_STAFF_ID, status: "all" })
    assertEquals(ledgerAfter.status, 200)
    const rowAfter = ((await ledgerAfter.json()).commissions as Array<Record<string, unknown>>).find((c) => c.appointment_id === booking.id)
    if (!rowAfter) throw new Error(`Expected to still find appointment ${booking.id} in the commissions ledger after the rate change`)
    assertEquals(rowAfter.commission_amount, 10)
  } finally {
    // Restore the service's original commission config regardless of outcome.
    await callServices("PATCH", OWNER_TOKEN, { staff_commission_type: originalType, staff_commission_value: originalValue }, { id: TEST_SERVICE_ID })
  }
})

// ── dual-staff secondary-role ledger visibility ─────────────────────────────

Deno.test("staff: commissions — a Support-role (secondary) staff member's split-adjusted commission is visible in their own ledger", async () => {
  if (!OWNER_TOKEN) return

  // S58 Test — Dual Staff Service (requires_two_staff = true), seeded
  // specifically for dual-staff scenarios like this one — not otherwise
  // booked by any other test.
  const DUAL_SERVICE_ID = "c0000000-0000-4000-8000-000000000005"
  const SECONDARY_STAFF_ID = "d0000000-0000-4000-8000-000000000002" // Regina M.

  const listRes = await callServices("GET", OWNER_TOKEN, undefined, { business_id: TEST_BUSINESS_ID })
  const services = await listRes.json()
  const original = (services as Array<Record<string, unknown>>).find((s) => s.id === DUAL_SERVICE_ID)
  if (!original) throw new Error(`Expected to find service ${DUAL_SERVICE_ID} in the services list`)
  const originalType = original.staff_commission_type
  const originalValue = original.staff_commission_value

  try {
    // Known rate: 20% — with the service's default 50/50 split, primary and
    // secondary should each earn 100 * 20% * 50% = 10.
    const setRateRes = await callServices("PATCH", OWNER_TOKEN, { staff_commission_type: "percentage", staff_commission_value: 20 }, { id: DUAL_SERVICE_ID })
    assertEquals(setRateRes.status, 200)

    const bookingRes = await callAppointments("POST", OWNER_TOKEN, {
      business_id: TEST_BUSINESS_ID,
      client_id: TEST_CLIENT_ID,
      service_id: DUAL_SERVICE_ID,
      staff_profile_id: TEST_STAFF_ID,
      date: "2027-03-20",
      time: "11:00",
      duration_minutes: 60,
      price: 100,
      payment_method: "later",
    })
    assertEquals(bookingRes.status, 201)
    const booking = await bookingRes.json()

    const assign2Res = await callAppointments("PATCH", OWNER_TOKEN, { staff_profile_id_2: SECONDARY_STAFF_ID }, { action: "assign-staff-2", id: booking.id })
    if (assign2Res.status !== 200) {
      const errBody = await assign2Res.json().catch(() => null)
      throw new Error(`Expected 200 assigning secondary staff, got ${assign2Res.status}: ${JSON.stringify(errBody)}`)
    }

    const completeRes = await callAppointments("PATCH", OWNER_TOKEN, { status: "completed", payment_method: "cash" }, { id: booking.id })
    assertEquals(completeRes.status, 200)

    const primaryLedgerRes = await call("GET", OWNER_TOKEN, undefined, { action: "commissions", staff_id: TEST_STAFF_ID, status: "all" })
    assertEquals(primaryLedgerRes.status, 200)
    const primaryRow = ((await primaryLedgerRes.json()).commissions as Array<Record<string, unknown>>).find((c) => c.appointment_id === booking.id)
    if (!primaryRow) throw new Error(`Expected primary staff's ledger to include appointment ${booking.id}`)
    assertEquals(primaryRow.role, "primary")
    assertEquals(primaryRow.commission_amount, 10)

    // The bug this fixes: before this change, a secondary/support staff
    // member's own ledger never included appointments where they were
    // staff_profile_id_2 — this appointment simply never appeared.
    const secondaryLedgerRes = await call("GET", OWNER_TOKEN, undefined, { action: "commissions", staff_id: SECONDARY_STAFF_ID, status: "all" })
    assertEquals(secondaryLedgerRes.status, 200)
    const secondaryRow = ((await secondaryLedgerRes.json()).commissions as Array<Record<string, unknown>>).find((c) => c.appointment_id === booking.id)
    if (!secondaryRow) throw new Error(`Expected secondary staff's ledger to include appointment ${booking.id} — this is the gap the fix closes`)
    assertEquals(secondaryRow.role, "secondary")
    assertEquals(secondaryRow.commission_amount, 10)
  } finally {
    await callServices("PATCH", OWNER_TOKEN, { staff_commission_type: originalType, staff_commission_value: originalValue }, { id: DUAL_SERVICE_ID })
  }
})
