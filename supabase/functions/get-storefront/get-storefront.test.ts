// supabase/functions/get-storefront/get-storefront.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // afrotouch, from seed
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

function callFn(slug?: string) {
  const url = slug ? `${BASE}/get-storefront?slug=${slug}` : `${BASE}/get-storefront`
  return fetch(url, { method: "GET", headers: { "apikey": ANON_KEY } })
}

// Own /services calls for the draft-visibility regression below —
// get-storefront.test.ts otherwise never talks to /services.
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

Deno.test("get-storefront: missing slug", async () => {
  const res = await callFn()
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("get-storefront: non-existent slug", async () => {
  const res = await callFn("notarealsalon")
  assertEquals(res.status, 404)
  await res.body?.cancel()
})

Deno.test("get-storefront: valid slug (afrotouch)", async () => {
  const res = await callFn("afrotouch")
  assertEquals(res.status, 200)
  const data = await res.json()
  // Response uses 'team' for staff members and has business fields at top level
  if (!Array.isArray(data.services)) throw new Error("Missing services array")
  if (!Array.isArray(data.team)) throw new Error("Missing team array")
  if (!data.name || !data.slug) throw new Error("Missing business fields (name, slug)")
})

// ── draft-service visibility (WEB-OWNER-SERVICES-01) ───────────────────────
// The wizard's status='draft' services must never leak onto the public
// storefront — this is the direct regression check for the server-side
// is_active=false guard in POST/PATCH /services (defense in depth beyond
// the frontend's own guard).

Deno.test("get-storefront: a draft service does not appear publicly", async () => {
  if (!OWNER_TOKEN) return

  const createRes = await callServices("POST", OWNER_TOKEN, {
    business_id: BUSINESS_ID,
    name: `Draft Storefront Test ${Date.now()}`,
    price: 30,
    duration_minutes: 30,
    status: "draft",
    // Even if the caller lies about is_active/is_public, the draft must
    // still end up hidden — that's the whole point of the server-side guard.
    is_active: true,
    is_public: true,
  })
  assertEquals(createRes.status, 201)
  const draft = await createRes.json()
  assertEquals(draft.status, "draft")
  assertEquals(draft.is_active, false)

  const storefrontRes = await callFn("afrotouch")
  assertEquals(storefrontRes.status, 200)
  const data = await storefrontRes.json()
  const found = (data.services as Array<Record<string, unknown>>).find((s) => s.id === draft.id)
  if (found) throw new Error(`Draft service ${draft.id} must not appear on the public storefront`)
})
