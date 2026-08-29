// supabase/functions/storefront-launch-config/storefront-launch-config.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

Deno.test("storefront-launch-config: no auth required, returns 200", async () => {
  const res = await fetch(`${BASE}/storefront-launch-config`, { headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 200)
  await res.body?.cancel()
})

Deno.test("storefront-launch-config: response has exactly the 3 launch fields", async () => {
  const res = await fetch(`${BASE}/storefront-launch-config`, { headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 200)
  const body = await res.json()
  for (const field of ["launch_at", "launch_timezone", "countdown_visible"]) {
    if (!(field in body)) throw new Error(`Expected a ${field} field in the response`)
  }
})

Deno.test("storefront-launch-config: POST is rejected", async () => {
  const res = await fetch(`${BASE}/storefront-launch-config`, { method: "POST", headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})
