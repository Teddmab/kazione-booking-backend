// supabase/functions/admin-partners/admin-partners.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

const ADMIN_TOKEN = Deno.env.get("TEST_ADMIN_TOKEN") || ""
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

function call(method: string, token?: string, body?: unknown, id?: string) {
  const headers: Record<string, string> = { apikey: ANON_KEY, "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const qs = id ? `?id=${id}` : ""
  return fetch(`${BASE}/admin-partners${qs}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

Deno.test("admin-partners: no Authorization header → 401", async () => {
  const res = await call("GET")
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("admin-partners: authenticated but non-admin (seeded owner) → 403", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("GET", OWNER_TOKEN)
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("admin-partners: platform admin → GET returns a partners array", async () => {
  if (!ADMIN_TOKEN) return
  const res = await call("GET", ADMIN_TOKEN)
  assertEquals(res.status, 200)
  const body = await res.json()
  if (!Array.isArray(body.partners)) throw new Error("Expected a partners array")
})

Deno.test("admin-partners: POST without name/logo_url → 400", async () => {
  if (!ADMIN_TOKEN) return
  const res = await call("POST", ADMIN_TOKEN, { name: "" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("admin-partners: full create → update → delete lifecycle", async () => {
  if (!ADMIN_TOKEN) return

  const createRes = await call("POST", ADMIN_TOKEN, {
    name: "Test Partner",
    logo_url: "https://example.com/logo.png",
    website_url: "https://example.com",
  })
  if (createRes.status !== 201) {
    const body = await createRes.json().catch(() => null)
    throw new Error(`Expected 201, got ${createRes.status}: ${JSON.stringify(body)}`)
  }
  const created = await createRes.json()
  assertEquals(created.name, "Test Partner")
  assertEquals(created.is_enabled, true)

  const updateRes = await call("PATCH", ADMIN_TOKEN, { is_enabled: false, display_order: 5 }, created.id)
  assertEquals(updateRes.status, 200)
  const updated = await updateRes.json()
  assertEquals(updated.is_enabled, false)
  assertEquals(updated.display_order, 5)

  // Disabled partner must not appear in the public listing.
  const publicRes = await fetch(`${BASE}/platform-partners`, { headers: { apikey: ANON_KEY } })
  const publicBody = await publicRes.json()
  if (publicBody.partners.some((p: { id: string }) => p.id === created.id)) {
    throw new Error("Disabled partner leaked into the public listing")
  }

  const deleteRes = await call("DELETE", ADMIN_TOKEN, undefined, created.id)
  assertEquals(deleteRes.status, 200)
})

Deno.test("admin-partners: PATCH/DELETE without id → 400", async () => {
  if (!ADMIN_TOKEN) return
  const patchRes = await call("PATCH", ADMIN_TOKEN, { name: "x" })
  assertEquals(patchRes.status, 400)
  await patchRes.body?.cancel()

  const deleteRes = await call("DELETE", ADMIN_TOKEN)
  assertEquals(deleteRes.status, 400)
  await deleteRes.body?.cancel()
})
