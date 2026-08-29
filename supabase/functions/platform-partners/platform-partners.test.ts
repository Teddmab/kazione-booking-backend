// supabase/functions/platform-partners/platform-partners.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

Deno.test("platform-partners: no auth required, returns 200 with a partners array", async () => {
  const res = await fetch(`${BASE}/platform-partners`, { headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 200)
  const body = await res.json()
  if (!Array.isArray(body.partners)) throw new Error("Expected a partners array")
})

Deno.test("platform-partners: POST is rejected", async () => {
  const res = await fetch(`${BASE}/platform-partners`, { method: "POST", headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})
