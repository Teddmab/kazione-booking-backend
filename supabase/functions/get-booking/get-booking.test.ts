// supabase/functions/get-booking/get-booking.test.ts
//
// Covers S57 finding 1: get-booking must not return a booking (and its
// client PII) to a caller who cannot prove a valid cancel token, ownership,
// or business membership — and must return the SAME generic 404 whether
// the booking doesn't exist or the caller just isn't authorized for it, so
// the endpoint can't be used to enumerate valid ids/references.
import { assertEquals } from "std/assert";

const BASE = "http://127.0.0.1:54321/functions/v1";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function call(params: Record<string, string>, token?: string) {
  const url = new URL(`${BASE}/get-booking`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers: Record<string, string> = { apikey: ANON_KEY };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url.toString(), { headers });
}

Deno.test("get-booking: missing id and booking_reference → 400", async () => {
  const res = await call({});
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("get-booking: nonexistent booking_reference, no credentials → generic 404", async () => {
  const res = await call({ booking_reference: "KZB-00000" });
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error.message, "Booking not found");
});

Deno.test("get-booking: real booking id, no cancel token, no auth → same generic 404 (no enumeration leak)", async () => {
  // Requires a real seeded appointment id — set TEST_APPT_ID to exercise the
  // enumeration-resistance property against a booking that genuinely exists.
  const apptId = Deno.env.get("TEST_APPT_ID") || "";
  if (!apptId) return;
  const res = await call({ id: apptId });
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error.message, "Booking not found");
});

Deno.test("get-booking: real booking + wrong/garbage cancel_token → 404, not 200", async () => {
  const apptId = Deno.env.get("TEST_APPT_ID") || "";
  if (!apptId) return;
  const res = await call({ id: apptId, cancel_token: "not-a-real-token" });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("get-booking: real booking + its own valid cancel_token → 200 with client details", async () => {
  // Same fixture pair cancel-booking.test.ts already documents.
  const apptId = Deno.env.get("TEST_APPT_ID") || "";
  const cancelToken = Deno.env.get("TEST_APPT_CANCEL_TOKEN") || "";
  if (!apptId || !cancelToken) return;
  const res = await call({ id: apptId, cancel_token: cancelToken });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.booking.id, apptId);
});

Deno.test("get-booking: real booking + authenticated owner token for that business → 200", async () => {
  const apptId = Deno.env.get("TEST_APPT_ID") || "";
  const ownerToken = Deno.env.get("TEST_OWNER_TOKEN") || "";
  if (!apptId || !ownerToken) return;
  const res = await call({ id: apptId }, ownerToken);
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

Deno.test("get-booking: real booking + authenticated client's own JWT (not owner/token) → 200", async () => {
  const apptId = Deno.env.get("TEST_APPT_ID") || "";
  const clientToken = Deno.env.get("TEST_CLIENT_TOKEN") || "";
  if (!apptId || !clientToken) return;
  const res = await call({ id: apptId }, clientToken);
  assertEquals(res.status, 200);
  await res.body?.cancel();
});
