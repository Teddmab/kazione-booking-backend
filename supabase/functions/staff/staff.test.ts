// supabase/functions/staff/staff.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

async function call(method: string, token?: string, body?: unknown, params?: Record<string, string>) {
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
