// supabase/functions/admin-alert-settings/admin-alert-settings.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

const ADMIN_TOKEN = Deno.env.get("TEST_ADMIN_TOKEN") || ""
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

function call(method: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { apikey: ANON_KEY, "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${BASE}/admin-alert-settings`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

Deno.test("admin-alert-settings: no Authorization header → 401", async () => {
  const res = await call("GET")
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("admin-alert-settings: authenticated but non-admin (seeded owner) → 403", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("GET", OWNER_TOKEN)
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("admin-alert-settings: platform admin → GET returns alert_email field", async () => {
  if (!ADMIN_TOKEN) return
  const res = await call("GET", ADMIN_TOKEN)
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const body = await res.json()
  if (!("alert_email" in body)) throw new Error("Expected an alert_email field in the response")
})

Deno.test("admin-alert-settings: PATCH invalid email → 400", async () => {
  if (!ADMIN_TOKEN) return
  const res = await call("PATCH", ADMIN_TOKEN, { alert_email: "not-an-email" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("admin-alert-settings: PATCH missing alert_email field → 400", async () => {
  if (!ADMIN_TOKEN) return
  const res = await call("PATCH", ADMIN_TOKEN, {})
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("admin-alert-settings: platform admin sets alert_email → 200, persisted on next GET, then cleared", async () => {
  if (!ADMIN_TOKEN) return

  const setRes = await call("PATCH", ADMIN_TOKEN, { alert_email: "ops-test@kazione.internal" })
  if (setRes.status !== 200) {
    const body = await setRes.json().catch(() => null)
    throw new Error(`Expected 200, got ${setRes.status}: ${JSON.stringify(body)}`)
  }
  const setBody = await setRes.json()
  assertEquals(setBody.alert_email, "ops-test@kazione.internal")

  const getRes = await call("GET", ADMIN_TOKEN)
  assertEquals(getRes.status, 200)
  const getBody = await getRes.json()
  assertEquals(getBody.alert_email, "ops-test@kazione.internal")

  // Restore to unset so this file can be re-run without depending on order,
  // and so it doesn't leave a stray real-looking address configured for
  // whichever test runs platform-alert-digest next.
  const clearRes = await call("PATCH", ADMIN_TOKEN, { alert_email: "" })
  assertEquals(clearRes.status, 200)
  const clearBody = await clearRes.json()
  assertEquals(clearBody.alert_email, null)
})
