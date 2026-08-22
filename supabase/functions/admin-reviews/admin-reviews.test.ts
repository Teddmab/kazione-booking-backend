// supabase/functions/admin-reviews/admin-reviews.test.ts
//
// S61: first-ever admin-* function test in this codebase to actually
// authenticate as a real platform admin. Previously no seeded platform-admin
// user existed, so this whole call path (requirePlatformAdmin's success
// branch) had never been exercised by CI for ANY admin-* function — only its
// 401/403 rejection paths were reachable without a real admin JWT. seed.sql
// now seeds admin@kazione.internal (is_platform_admin=true) and ci.yml fetches
// TEST_ADMIN_TOKEN for it the same way it already does for TEST_OWNER_TOKEN,
// per CLAUDE.md Rule 7 — no env-var-gated skip for what can run for real.
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const REST_BASE = "http://127.0.0.1:54321/rest/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

const ADMIN_TOKEN = Deno.env.get("TEST_ADMIN_TOKEN") || ""
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

// seed.sql "Test reviews (S61)" — a real review on the foreign test business
// (b0000000-...002). Used here (rather than the owner's own-business review)
// so this file's mutations never collide with reviews/reviews.test.ts's use
// of the same fixture.
const REVIEW_ID = "e0000000-0000-4000-8000-000000000002"

function moderate(id: string, body: Record<string, unknown>, token?: string) {
  const url = new URL(`${BASE}/admin-reviews`)
  url.searchParams.set("id", id)
  const headers: Record<string, string> = {
    apikey: ANON_KEY,
    "Content-Type": "application/json",
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(url.toString(), { method: "PATCH", headers, body: JSON.stringify(body) })
}

function list(token?: string) {
  const url = new URL(`${BASE}/admin-reviews`)
  const headers: Record<string, string> = { apikey: ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(url.toString(), { headers })
}

Deno.test("admin-reviews: no Authorization header → 401", async () => {
  const res = await list()
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("admin-reviews: authenticated but non-admin (seeded owner) → 403", async () => {
  if (!OWNER_TOKEN) return
  const res = await list(OWNER_TOKEN)
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("admin-reviews: platform admin → GET returns a paginated list", async () => {
  if (!ADMIN_TOKEN) return
  const res = await list(ADMIN_TOKEN)
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const body = await res.json()
  if (!Array.isArray(body.data)) throw new Error("Expected body.data to be an array")
  if (typeof body.total !== "number") throw new Error("Expected body.total to be a number")
})

Deno.test("admin-reviews: platform admin — missing reason → 400", async () => {
  if (!ADMIN_TOKEN) return
  const res = await moderate(REVIEW_ID, { is_public: false }, ADMIN_TOKEN)
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("admin-reviews: platform admin can hide ANY review (cross-tenant) → 200 + admin_audit_log row", async () => {
  if (!ADMIN_TOKEN) return

  const res = await moderate(
    REVIEW_ID,
    { is_public: false, reason: "S61 admin-hide-any test" },
    ADMIN_TOKEN,
  )
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const body = await res.json()
  assertEquals(body.id, REVIEW_ID)
  assertEquals(body.is_public, false)

  // Verify the audit trail directly via PostgREST — admin_read_audit_log's
  // RLS policy lets any platform admin read admin_audit_log (migration
  // 045_admin_audit_log.sql).
  const logRes = await fetch(
    `${REST_BASE}/admin_audit_log?action=eq.REVIEW_HIDDEN&target_id=eq.${REVIEW_ID}&order=created_at.desc&limit=1`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ADMIN_TOKEN}` } },
  )
  assertEquals(logRes.status, 200)
  const rows = await logRes.json()
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Expected a REVIEW_HIDDEN row in admin_audit_log for this review")
  }

  // Restore state so this file can be re-run without depending on order.
  const restoreRes = await moderate(
    REVIEW_ID,
    { is_public: true, reason: "Restoring after test" },
    ADMIN_TOKEN,
  )
  assertEquals(restoreRes.status, 200)
  await restoreRes.body?.cancel()
})
