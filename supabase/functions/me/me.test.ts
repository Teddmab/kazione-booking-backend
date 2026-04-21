// supabase/functions/me/me.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

async function callFn(method: string, token?: string, body?: any) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  return fetch(`${BASE}/me`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
}

Deno.test("me: no auth token", async () => {
  const res = await callFn("GET")
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

// The following tests require a valid owner token
// Replace OWNER_TOKEN with a real JWT for local testing
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

Deno.test("me: valid owner token", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("GET", OWNER_TOKEN)
  assertEquals(res.status, 200)
})

Deno.test("me: PATCH with valid data", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("PATCH", OWNER_TOKEN, { first_name: "Test", last_name: "Owner" })
  assertEquals(res.status, 200)
})

Deno.test("me: PATCH with invalid field", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("PATCH", OWNER_TOKEN, { not_a_field: "foo" })
  assertEquals(res.status, 400)
})
