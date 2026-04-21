// supabase/functions/get-storefront/get-storefront.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

async function callFn(slug?: string) {
  const url = slug ? `${BASE}/get-storefront?slug=${slug}` : `${BASE}/get-storefront`
  return fetch(url, { method: "GET", headers: { "apikey": ANON_KEY } })
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
