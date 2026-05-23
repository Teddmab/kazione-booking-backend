// supabase/functions/gdpr/gdpr.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""
const CLIENT_TOKEN = Deno.env.get("TEST_CLIENT_TOKEN") || ""

function call(method: string, token?: string, body?: unknown, params?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  let url = `${BASE}/gdpr`
  if (params) {
    const u = new URL(url)
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
    url = u.toString()
  }
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

// ── GET /gdpr — invalid action ────────────────────────────────────────────────

Deno.test("gdpr: GET without action → 400", async () => {
  const res = await call("GET", OWNER_TOKEN || undefined)
  if (![400, 401].includes(res.status)) throw new Error(`Expected 400 or 401, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("gdpr: GET invalid action → 400", async () => {
  const res = await call("GET", OWNER_TOKEN || undefined, undefined, { action: "nuke" })
  if (![400, 401].includes(res.status)) throw new Error(`Expected 400 or 401, got ${res.status}`)
  await res.body?.cancel()
})

// ── GET /gdpr?action=export ───────────────────────────────────────────────────

Deno.test("gdpr: export without auth → 401 or 403", async () => {
  const res = await call("GET", undefined, undefined, { action: "export" })
  if (![401, 403].includes(res.status)) throw new Error(`Expected 401 or 403, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("gdpr: export with client token → 200 with correct shape", async () => {
  if (!CLIENT_TOKEN) return
  const res = await call("GET", CLIENT_TOKEN, undefined, { action: "export" })
  assertEquals(res.status, 200)
  const data = await res.json()
  if (!data.exported_at) throw new Error("Missing exported_at")
  if (!data.profile) throw new Error("Missing profile object")
  if (!Array.isArray(data.appointments)) throw new Error("Missing appointments array")
  if (!Array.isArray(data.payments)) throw new Error("Missing payments array")
  if (!data.consents) throw new Error("Missing consents object")
  if ("internal_notes" in (data.profile ?? {})) throw new Error("internal_notes must not be exported")
})

Deno.test("gdpr: export with owner token → 404 (owner has no client record)", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("GET", OWNER_TOKEN, undefined, { action: "export" })
  if (![404, 200].includes(res.status)) throw new Error(`Expected 404 or 200, got ${res.status}`)
  await res.body?.cancel()
})

// ── DELETE /gdpr — client self-erasure (GDPR Article 17) ─────────────────────

Deno.test("gdpr: self-delete without auth → 401 or 403", async () => {
  const res = await call("DELETE", undefined, { confirm: true })
  if (![401, 403].includes(res.status)) throw new Error(`Expected 401 or 403, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("gdpr: self-delete without confirm → 400", async () => {
  if (!CLIENT_TOKEN) return
  const res = await call("DELETE", CLIENT_TOKEN, {})
  assertEquals(res.status, 400)
  const data = await res.json()
  if (!data.error) throw new Error("Expected error envelope in response")
  await res.body?.cancel()
})

Deno.test("gdpr: self-delete with confirm=false → 400", async () => {
  if (!CLIENT_TOKEN) return
  const res = await call("DELETE", CLIENT_TOKEN, { confirm: false })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

// ── DELETE /gdpr?action=delete — owner-initiated anonymisation ────────────────

Deno.test("gdpr: owner-delete without auth → 401 or 403", async () => {
  const res = await call("DELETE", undefined, {}, { action: "delete" })
  if (![401, 403].includes(res.status)) throw new Error(`Expected 401 or 403, got ${res.status}`)
  await res.body?.cancel()
})

Deno.test("gdpr: owner-delete without business_id → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("DELETE", OWNER_TOKEN, {}, { action: "delete" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("gdpr: owner-delete missing client_id → 400", async () => {
  if (!OWNER_TOKEN) return
  const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001"
  const res = await call("DELETE", OWNER_TOKEN, { business_id: BUSINESS_ID }, { action: "delete" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("gdpr: owner-delete non-existent client_id → 404", async () => {
  if (!OWNER_TOKEN) return
  const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001"
  const res = await call("DELETE", OWNER_TOKEN, {
    business_id: BUSINESS_ID,
    client_id: "00000000-0000-0000-0000-000000000000",
  }, { action: "delete" })
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

// ── Method guards ─────────────────────────────────────────────────────────────

Deno.test("gdpr: POST is not supported → 400 or 401", async () => {
  const res = await call("POST", OWNER_TOKEN || undefined, {}, { action: "export" })
  if (![400, 401].includes(res.status)) throw new Error(`Expected 400 or 401, got ${res.status}`)
  await res.body?.cancel()
})
