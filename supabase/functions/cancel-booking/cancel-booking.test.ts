// supabase/functions/cancel-booking/cancel-booking.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"

async function callFn(body: any) {
  return fetch(`${BASE}/cancel-booking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
    body: JSON.stringify(body),
  })
}

Deno.test("cancel-booking: missing appointment_id", async () => {
  const res = await callFn({})
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("cancel-booking: invalid cancel token", async () => {
  const res = await callFn({ cancel_token: "invalidtoken" })
  assertEquals(res.status, 403)
  await res.body?.cancel()
})


// These require a real appointment to be created and cancelled
Deno.test("cancel-booking: valid cancellation with token", async () => {
  // This test assumes you have a valid appointment_id and cancel_token from a seeded booking
  const appointment_id = Deno.env.get("TEST_APPT_ID") || "";
  const cancel_token = Deno.env.get("TEST_APPT_CANCEL_TOKEN") || "";
  if (!appointment_id || !cancel_token) return;
  const res = await callFn({ appointment_id, cancel_token });
  // Accept 200 (success) or 409 (already cancelled)
  if (![200,409].includes(res.status)) throw new Error(`Expected 200 or 409, got ${res.status}`);
});

Deno.test("cancel-booking: already cancelled appointment", async () => {
  // This test assumes you have a valid appointment_id and cancel_token from a booking that was already cancelled
  const appointment_id = Deno.env.get("TEST_CANCELLED_APPT_ID") || "";
  const cancel_token = Deno.env.get("TEST_CANCELLED_APPT_TOKEN") || "";
  if (!appointment_id || !cancel_token) return;
  const res = await callFn({ appointment_id, cancel_token });
  assertEquals(res.status, 409);
});
