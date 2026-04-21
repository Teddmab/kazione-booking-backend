// supabase/functions/appointments/appointments.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // from seed
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

async function callFn(method: string, token?: string, body?: any, params?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  let url = `${BASE}/appointments`
  if (params) {
    const u = new URL(url)
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
    url = u.toString()
  }
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

Deno.test("appointments: GET without auth", async () => {
  const res = await callFn("GET", undefined, undefined, { business_id: BUSINESS_ID })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("appointments: GET with owner token", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("GET", OWNER_TOKEN, undefined, { business_id: BUSINESS_ID })
  assertEquals(res.status, 200)
})

// The following require more setup for PATCH and date filter
// Deno.test("appointments: GET with date filter", async () => { ... })
// Deno.test("appointments: PATCH status to invalid value", async () => { ... })
// Deno.test("appointments: PATCH status from different business", async () => { ... })
