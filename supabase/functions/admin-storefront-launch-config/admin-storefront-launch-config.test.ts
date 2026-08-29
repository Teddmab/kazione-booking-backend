// supabase/functions/admin-storefront-launch-config/admin-storefront-launch-config.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

const ADMIN_TOKEN = Deno.env.get("TEST_ADMIN_TOKEN") || ""
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

function call(method: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { apikey: ANON_KEY, "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${BASE}/admin-storefront-launch-config`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

Deno.test("admin-storefront-launch-config: no Authorization header → 401", async () => {
  const res = await call("GET")
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("admin-storefront-launch-config: authenticated but non-admin (seeded owner) → 403", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("GET", OWNER_TOKEN)
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("admin-storefront-launch-config: platform admin → GET returns the 3 launch fields", async () => {
  if (!ADMIN_TOKEN) return
  const res = await call("GET", ADMIN_TOKEN)
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const body = await res.json()
  for (const field of ["launch_at", "launch_timezone", "countdown_visible"]) {
    if (!(field in body)) throw new Error(`Expected a ${field} field in the response`)
  }
})

Deno.test("admin-storefront-launch-config: enabling countdown without a date → 400", async () => {
  if (!ADMIN_TOKEN) return
  const clearRes = await call("PATCH", ADMIN_TOKEN, { launch_at: null, launch_timezone: null, countdown_visible: false })
  assertEquals(clearRes.status, 200)
  await clearRes.body?.cancel()

  const res = await call("PATCH", ADMIN_TOKEN, { countdown_visible: true })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("admin-storefront-launch-config: invalid timezone → 400", async () => {
  if (!ADMIN_TOKEN) return
  const res = await call("PATCH", ADMIN_TOKEN, { launch_timezone: "Not/AZone" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("admin-storefront-launch-config: sets a valid launch date+timezone, persisted on next GET, then cleared", async () => {
  if (!ADMIN_TOKEN) return

  const setRes = await call("PATCH", ADMIN_TOKEN, {
    launch_at: "2027-02-01T00:00:00.000Z",
    launch_timezone: "Europe/Tallinn",
    countdown_visible: true,
  })
  if (setRes.status !== 200) {
    const body = await setRes.json().catch(() => null)
    throw new Error(`Expected 200, got ${setRes.status}: ${JSON.stringify(body)}`)
  }
  const setBody = await setRes.json()
  assertEquals(setBody.launch_timezone, "Europe/Tallinn")
  assertEquals(setBody.countdown_visible, true)

  const getRes = await call("GET", ADMIN_TOKEN)
  assertEquals(getRes.status, 200)
  const getBody = await getRes.json()
  assertEquals(getBody.launch_timezone, "Europe/Tallinn")

  const publicRes = await fetch(`${BASE}/storefront-launch-config`, { headers: { apikey: ANON_KEY } })
  assertEquals(publicRes.status, 200)
  const publicBody = await publicRes.json()
  assertEquals(publicBody.launch_timezone, "Europe/Tallinn")
  assertEquals(publicBody.countdown_visible, true)

  // Restore to unset so this file (and storefront-launch-config's own tests)
  // can be re-run without depending on whatever ran before it.
  const clearRes = await call("PATCH", ADMIN_TOKEN, { launch_at: null, launch_timezone: null, countdown_visible: false })
  assertEquals(clearRes.status, 200)
})
