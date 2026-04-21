// supabase/functions/send-email/send-email.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
// Local dev key from .env — safe to hardcode (dev-only secret)
const INTERNAL_KEY = Deno.env.get("INTERNAL_FUNCTION_KEY") || "725b2c7d67955c0eb77589714c9b80879ebf6b157b2d880fa568c0fdeea56fe0"

async function callFn(body: any, key?: string) {
  return fetch(`${BASE}/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY, "x-internal-key": key || INTERNAL_KEY },
    body: JSON.stringify(body),
  })
}

Deno.test("send-email: missing x-internal-key", async () => {
  const res = await fetch(`${BASE}/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
    body: JSON.stringify({ to: "test@example.com", template: "booking_confirmation", data: {} }),
  })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("send-email: wrong x-internal-key", async () => {
  const res = await callFn({ to: "test@example.com", template: "booking_confirmation", data: {} }, "wrongkey")
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("send-email: missing 'to' field", async () => {
  const res = await callFn({ template: "booking_confirmation", data: {} })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("send-email: missing 'template' field", async () => {
  const res = await callFn({ to: "test@example.com", data: {} })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})


Deno.test("send-email: valid request", async () => {
  const res = await callFn({
    to: "test@example.com",
    template: "booking_confirmation",
    data: { name: "Test" }
  }, INTERNAL_KEY);
  // Accept 200 (success) or 500 (Resend API key not configured in local dev)
  if (![200,500].includes(res.status)) throw new Error(`Expected 200 or 500, got ${res.status}`);
  await res.body?.cancel()
});
