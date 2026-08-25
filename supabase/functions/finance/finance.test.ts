// supabase/functions/finance/finance.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""
const TEST_BUSINESS_ID = "b0000000-0000-4000-8000-000000000001"
// Fatima K. — the S61 review-seed appointment (f...098, 2026-07-01, rating 4,
// is_public true) is her only public review in this business's seed data.
const TEST_STAFF_ID = "d0000000-0000-4000-8000-000000000001"

function call(params: Record<string, string>, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const url = new URL(`${BASE}/finance`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return fetch(url.toString(), { headers })
}

Deno.test("finance: staff-performance — review_count matches avg_rating's own seeded review", async () => {
  if (!OWNER_TOKEN) return

  const res = await call({
    action: "staff-performance",
    business_id: TEST_BUSINESS_ID,
    from: "2026-07-01",
    to: "2026-07-01",
  }, OWNER_TOKEN)
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const rows = await res.json()
  if (!Array.isArray(rows)) throw new Error("Expected an array response")

  const row = rows.find((r: Record<string, unknown>) => r.staff_profile_id === TEST_STAFF_ID)
  if (!row) throw new Error(`Expected a row for staff_profile_id ${TEST_STAFF_ID}`)
  assertEquals(row.avg_rating, 4)
  assertEquals(row.review_count, 1)
})
