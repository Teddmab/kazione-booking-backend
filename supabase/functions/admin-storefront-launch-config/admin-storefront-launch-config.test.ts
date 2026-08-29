// supabase/functions/admin-storefront-launch-config/admin-storefront-launch-config.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

const ADMIN_TOKEN = Deno.env.get("TEST_ADMIN_TOKEN") || ""
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

function call(method: string, action?: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { apikey: ANON_KEY, "Content-Type": "application/json" }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const qs = action ? `?action=${action}` : ""
  return fetch(`${BASE}/admin-storefront-launch-config${qs}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

const VALID_DRAFT = {
  launchAt: "2027-02-01T00:00:00Z",
  launchTimezone: "Europe/Tallinn",
  countdownVisible: true,
  earlyAccessEnabled: true,
  beautyShopStatus: "coming_soon",
  quickServiceStatus: "coming_soon",
  quickServiceRegions: [],
  heroSlides: [
    {
      key: "salons",
      enabled: true,
      order: 1,
      eyebrow: { en: "Salons" },
      title: { en: "Book a salon" },
      description: { en: "Test" },
      primaryAction: "early_access_salons",
      assetKey: "landing.hero.salons",
    },
  ],
}

Deno.test("admin-storefront-launch-config: no Authorization header → 401", async () => {
  const res = await call("GET")
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("admin-storefront-launch-config: authenticated but non-admin (seeded owner) → 403", async () => {
  if (!OWNER_TOKEN) return
  const res = await call("GET", undefined, OWNER_TOKEN)
  assertEquals(res.status, 403)
  await res.body?.cancel()
})

Deno.test("admin-storefront-launch-config: platform admin → GET returns draft/published/version fields", async () => {
  if (!ADMIN_TOKEN) return
  const res = await call("GET", undefined, ADMIN_TOKEN)
  if (res.status !== 200) {
    const body = await res.json().catch(() => null)
    throw new Error(`Expected 200, got ${res.status}: ${JSON.stringify(body)}`)
  }
  const body = await res.json()
  for (const field of ["draft", "published", "version"]) {
    if (!(field in body)) throw new Error(`Expected a ${field} field in the response`)
  }
})

Deno.test("admin-storefront-launch-config: publish with no timezone set → 400, does not publish", async () => {
  if (!ADMIN_TOKEN) return

  const patchRes = await call("PATCH", undefined, ADMIN_TOKEN, { launchTimezone: null, countdownVisible: true, launchAt: null })
  assertEquals(patchRes.status, 200)
  await patchRes.body?.cancel()

  const publishRes = await call("POST", "publish", ADMIN_TOKEN)
  assertEquals(publishRes.status, 400)
  await publishRes.body?.cancel()
})

Deno.test("admin-storefront-launch-config: quickServiceStatus=pilot with no regions → publish rejected", async () => {
  if (!ADMIN_TOKEN) return

  const patchRes = await call("PATCH", undefined, ADMIN_TOKEN, {
    ...VALID_DRAFT,
    quickServiceStatus: "pilot",
    quickServiceRegions: [],
  })
  assertEquals(patchRes.status, 200)
  await patchRes.body?.cancel()

  const publishRes = await call("POST", "publish", ADMIN_TOKEN)
  assertEquals(publishRes.status, 400)
  const publishBody = await publishRes.json()
  if (!String(publishBody?.error?.message ?? "").includes("quickServiceRegions")) {
    throw new Error(`Expected quickServiceRegions validation error, got: ${JSON.stringify(publishBody)}`)
  }
})

Deno.test("admin-storefront-launch-config: PATCH persists draft, publish copies draft→published and bumps version, public endpoint reflects it, unpublish clears it", async () => {
  if (!ADMIN_TOKEN) return

  const patchRes = await call("PATCH", undefined, ADMIN_TOKEN, VALID_DRAFT)
  assertEquals(patchRes.status, 200)
  const patchBody = await patchRes.json()
  assertEquals(patchBody.draft.launchTimezone, "Europe/Tallinn")

  const versionBefore = patchBody.version as number

  const publishRes = await call("POST", "publish", ADMIN_TOKEN)
  assertEquals(publishRes.status, 200)
  const publishBody = await publishRes.json()
  assertEquals(publishBody.version, versionBefore + 1)
  assertEquals(publishBody.published.launchTimezone, "Europe/Tallinn")

  const publicRes = await fetch(`${BASE}/storefront-launch-config`, { headers: { apikey: ANON_KEY } })
  assertEquals(publicRes.status, 200)
  const publicBody = await publicRes.json()
  assertEquals(publicBody.configured, true)
  assertEquals(publicBody.launchTimezone, "Europe/Tallinn")
  if ("draft" in publicBody) throw new Error("Public endpoint must never expose the draft field")

  // Restore to unpublished so this file can be re-run without depending on
  // whatever ran before it, and so it doesn't leave the public marketplace
  // pointed at test fixture data.
  const unpublishRes = await call("POST", "unpublish", ADMIN_TOKEN)
  assertEquals(unpublishRes.status, 200)
  const unpublishBody = await unpublishRes.json()
  assertEquals(unpublishBody.published, null)

  const publicAfterRes = await fetch(`${BASE}/storefront-launch-config`, { headers: { apikey: ANON_KEY } })
  assertEquals(publicAfterRes.status, 200)
  const publicAfterBody = await publicAfterRes.json()
  assertEquals(publicAfterBody.configured, false)
})
