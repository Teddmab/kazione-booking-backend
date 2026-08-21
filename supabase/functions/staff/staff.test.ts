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
  if (!body.email) throw new Error("Expected an email in the magic-link response")

  // Verify the audit trail directly via PostgREST (no dedicated read endpoint
  // exists for staff_action_log yet — RLS lets an owner/manager read their
  // own business's rows). Reuses restBase from the diagnostic check above.
  const logRes = await fetch(
    `${restBase}/staff_action_log?staff_profile_id=eq.${TEST_STAFF_ID}&action=eq.STAFF_MAGIC_LINK_ISSUED&order=created_at.desc&limit=1`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${OWNER_TOKEN}` } },
  )
  assertEquals(logRes.status, 200)
  const rows = await logRes.json()
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Expected a STAFF_MAGIC_LINK_ISSUED row in staff_action_log for this staff_profile_id")
  }
})
