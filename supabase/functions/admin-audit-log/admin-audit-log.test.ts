// supabase/functions/admin-audit-log/admin-audit-log.test.ts
//
// No test has ever existed for this endpoint — the first real
// platform-admin-authenticated request it's ever gotten in CI. Written
// after a user report that /audit "is simply failing" in the admin portal.
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

const ADMIN_TOKEN = Deno.env.get("TEST_ADMIN_TOKEN") || ""
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

function call(params: Record<string, string> = {}, token?: string) {
  const url = new URL(`${BASE}/admin-audit-log`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const headers: Record<string, string> = { apikey: ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(url.toString(), { headers })
}

Deno.test("admin-audit-log: no Authorization header → 401", async () => {
  const res = await call()
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("admin-audit-log: authenticated but non-admin (seeded owner) → 403", async () => {
  if (!OWNER_TOKEN) return
  const res = await call({}, OWNER_TOKEN)
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("admin-audit-log: platform admin → 200 with a well-formed page, admin embed resolves", async () => {
  if (!ADMIN_TOKEN) return

  // Every admin-* GET this session logs an audit row via logAdminAction —
  // by the time this test runs, plenty of other admin-*.test.ts files
  // (and this file's own earlier requests, once this one itself gets
  // logged) have already generated real admin_audit_log rows. Call twice:
  // the first call's own AUDIT_LOG_VIEWED write becomes visible to the second.
  const first = await call({}, ADMIN_TOKEN)
  if (first.status !== 200) {
    const body = await first.json().catch(() => null)
    throw new Error(`Expected 200, got ${first.status}: ${JSON.stringify(body)}`)
  }
  await first.json()

  const res = await call({ limit: "5" }, ADMIN_TOKEN)
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const body = await res.json()
  if (!Array.isArray(body.data)) throw new Error("Expected body.data to be an array")
  if (typeof body.total !== "number") throw new Error("Expected body.total to be a number")
  if (body.total < 1) throw new Error("Expected at least 1 row — this test's own prior call should have logged one")

  // Proves the admin:users!admin_audit_log_admin_id_fkey(...) embed actually
  // resolves — this is exactly the kind of embed that silently 500s
  // (PostgREST "more than one relationship was found") when the FK hint is
  // wrong, and it had never been exercised by any test before this one.
  const withAdmin = body.data.find((row: { admin: unknown }) => row.admin != null)
  if (!withAdmin) throw new Error("Expected at least one row with a resolved admin embed")
  if (typeof withAdmin.admin.email !== "string") {
    throw new Error(`Expected admin.email to be a string, got: ${JSON.stringify(withAdmin.admin)}`)
  }
})

Deno.test("admin-audit-log: filters by action", async () => {
  if (!ADMIN_TOKEN) return
  const res = await call({ action: "AUDIT_LOG_VIEWED", limit: "5" }, ADMIN_TOKEN)
  assertEquals(res.status, 200)
  const body = await res.json()
  for (const row of body.data as { action: string }[]) {
    assertEquals(row.action, "AUDIT_LOG_VIEWED")
  }
})
