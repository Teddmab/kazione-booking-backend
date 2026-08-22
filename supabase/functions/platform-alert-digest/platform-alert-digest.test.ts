// supabase/functions/platform-alert-digest/platform-alert-digest.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const REST_BASE = "http://127.0.0.1:54321/rest/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
// Local dev secret from .env — safe to hardcode (dev-only secret, same value
// ci.yml writes into supabase/functions/.env — see send-reminders.test.ts).
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "270d13cee3e549b6a57996077c1185a137f5b4f2b955dc9c504d9ec017186944"

const ADMIN_TOKEN = Deno.env.get("TEST_ADMIN_TOKEN") || ""

// seed.sql "Test platform_error_log row, unnotified" — a synthetic 5xx
// entry the digest should pick up and mark notified.
const FIXTURE_ERROR_ID = "a0000000-0000-4000-8000-000000000001"

function callDigest(token?: string) {
  const headers: Record<string, string> = { apikey: ANON_KEY, "Content-Type": "application/json" }
  if (token !== undefined) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${BASE}/platform-alert-digest`, { method: "POST", headers })
}

function callSettings(method: string, body?: unknown) {
  const headers: Record<string, string> = { apikey: ANON_KEY, "Content-Type": "application/json" }
  if (ADMIN_TOKEN) headers["Authorization"] = `Bearer ${ADMIN_TOKEN}`
  return fetch(`${BASE}/admin-alert-settings`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

Deno.test("platform-alert-digest: GET not allowed → 405", async () => {
  const res = await fetch(`${BASE}/platform-alert-digest`, { method: "GET", headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})

Deno.test("platform-alert-digest: missing Authorization header → 403", async () => {
  const res = await callDigest()
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("platform-alert-digest: wrong secret → 403", async () => {
  const res = await callDigest("not-the-real-secret")
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("platform-alert-digest: correct secret — drains the seeded unnotified error row and marks it notified", async () => {
  if (!ADMIN_TOKEN) return // needs a real admin token to set alert_email first

  // Make this test self-contained regardless of what admin-alert-settings.test.ts
  // is doing to the same singleton row: set a known alert_email right before use.
  const setRes = await callSettings("PATCH", { alert_email: "ops-test@kazione.internal" })
  assertEquals(setRes.status, 200)
  await setRes.json()

  const res = await callDigest(CRON_SECRET)
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const body = await res.json()
  if (body.errors_found < 1) {
    throw new Error(`Expected at least 1 unnotified error (the seed fixture), got ${body.errors_found}`)
  }
  assertEquals(body.emailed, true)

  // Verify the seeded fixture row actually flipped notified_at.
  const rowRes = await fetch(
    `${REST_BASE}/platform_error_log?id=eq.${FIXTURE_ERROR_ID}&select=notified_at`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ADMIN_TOKEN}` } },
  )
  assertEquals(rowRes.status, 200)
  const rows = await rowRes.json()
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Expected the seeded platform_error_log fixture row to exist")
  }
  if (!rows[0].notified_at) {
    throw new Error("Expected the seeded fixture row's notified_at to be set after the digest ran")
  }

  // Restore alert_email to unset for the rest of the suite.
  const clearRes = await callSettings("PATCH", { alert_email: "" })
  assertEquals(clearRes.status, 200)
  await clearRes.json()
})
