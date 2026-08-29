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

Deno.test("storefront-launch-config: response never contains a draft field", async () => {
  const res = await fetch(`${BASE}/storefront-launch-config`, { headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 200)
  const body = await res.json()
  if ("draft" in body) throw new Error("Public endpoint must never expose draft configuration")
})

Deno.test("storefront-launch-config: when nothing published, returns configured:false rather than an error", async () => {
  // This only asserts the shape holds when unpublished — the full publish
  // → configured:true → unpublish → configured:false round trip is covered
  // in admin-storefront-launch-config.test.ts, which owns state cleanup.
  const res = await fetch(`${BASE}/storefront-launch-config`, { headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 200)
  const body = await res.json()
  if (typeof body.configured !== "boolean") throw new Error("Expected a boolean 'configured' field")
})

Deno.test("storefront-launch-config: POST is rejected", async () => {
  const res = await fetch(`${BASE}/storefront-launch-config`, { method: "POST", headers: { apikey: ANON_KEY } })
  assertEquals(res.status, 405)
  await res.body?.cancel()
})
