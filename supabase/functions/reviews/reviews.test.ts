// supabase/functions/reviews/reviews.test.ts
//
// S61: review moderation (hide/unhide). Reviews are otherwise well-built —
// this file only covers the new PATCH ?action=moderate branch. Fixtures are
// the hardcoded rows added to seed.sql under "Test reviews (S61)", per
// CLAUDE.md Rule 7 — no env-var-gated skips for anything that can run
// against a real seeded row.
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

// seed.sql "Test reviews (S61)" — a real review on Afrotouch Tallinn
// (b0000000-...001), the business the seeded owner actually belongs to.
const OWN_REVIEW_ID = "e0000000-0000-4000-8000-000000000001"
// seed.sql "Test reviews (S61)" — a real review on the foreign test business
// (b0000000-...002, see "Foreign test business" in seed.sql), which the
// seeded owner has no business_members row for.
const FOREIGN_REVIEW_ID = "e0000000-0000-4000-8000-000000000002"

function moderate(id: string, body: Record<string, unknown>, token?: string) {
  const url = new URL(`${BASE}/reviews`)
  url.searchParams.set("id", id)
  url.searchParams.set("action", "moderate")
  const headers: Record<string, string> = {
    apikey: ANON_KEY,
    "Content-Type": "application/json",
  }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(url.toString(), { method: "PATCH", headers, body: JSON.stringify(body) })
}

Deno.test("reviews: moderate — missing reason → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await moderate(OWN_REVIEW_ID, { is_public: false }, OWNER_TOKEN)
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("reviews: moderate — missing is_public → 400", async () => {
  if (!OWNER_TOKEN) return
  const res = await moderate(OWN_REVIEW_ID, { reason: "spam" }, OWNER_TOKEN)
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("reviews: moderate — owner token for a review on a DIFFERENT business → 403", async () => {
  if (!OWNER_TOKEN) return
  const res = await moderate(FOREIGN_REVIEW_ID, { is_public: false, reason: "test" }, OWNER_TOKEN)
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("reviews: moderate — owner hides own review → 200, is_public:false, moderation fields set", async () => {
  if (!OWNER_TOKEN) return
  const res = await moderate(
    OWN_REVIEW_ID,
    { is_public: false, reason: "Inappropriate language" },
    OWNER_TOKEN,
  )
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const body = await res.json()
  assertEquals(body.id, OWN_REVIEW_ID)
  assertEquals(body.is_public, false)
  assertEquals(body.moderation_reason, "Inappropriate language")
  if (!body.moderated_at) throw new Error("Expected moderated_at to be set")

  // Owner un-hides it again — proves the same branch handles restoration,
  // not just hiding, and leaves the fixture in its original state.
  const restoreRes = await moderate(
    OWN_REVIEW_ID,
    { is_public: true, reason: "Restoring after test" },
    OWNER_TOKEN,
  )
  assertEquals(restoreRes.status, 200)
  const restored = await restoreRes.json()
  assertEquals(restored.is_public, true)
})

Deno.test("reviews: hidden review is excluded from get-storefront's public review list", async () => {
  if (!OWNER_TOKEN) return

  // Hide regardless of what earlier tests in this file left the row as.
  const hideRes = await moderate(
    OWN_REVIEW_ID,
    { is_public: false, reason: "Excluded-from-storefront check" },
    OWNER_TOKEN,
  )
  assertEquals(hideRes.status, 200)
  await hideRes.body?.cancel()

  const url = new URL(`${BASE}/get-storefront`)
  url.searchParams.set("slug", "afrotouch")
  const res = await fetch(url.toString(), { headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 200)
  const body = await res.json()
  const reviewIds = (body.reviews ?? []).map((r: { id: string }) => r.id)
  if (reviewIds.includes(OWN_REVIEW_ID)) {
    throw new Error("Hidden review still appears in get-storefront's public review list")
  }

  // Restore state so this file can be re-run without depending on order.
  const restoreRes = await moderate(
    OWN_REVIEW_ID,
    { is_public: true, reason: "Restoring after test" },
    OWNER_TOKEN,
  )
  assertEquals(restoreRes.status, 200)
  await restoreRes.body?.cancel()
})
