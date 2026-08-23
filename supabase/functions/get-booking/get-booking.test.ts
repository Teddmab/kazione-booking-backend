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
// Fixed seed fixture (seed.sql) — a real confirmed appointment with a
// staff_profile_id assigned, so authorized-fetch tests actually exercise
// Step 2's embedded-relations query instead of silently skipping. Previously
// this whole file depended on TEST_APPT_ID, which CI never sets — the exact
// reason a real bug (ambiguous staff:staff_profiles(...) embed, no
// !staff_profile_id hint) shipped without CI ever catching it.
const TEST_APPT_ID = "f0000000-0000-4000-8000-000000000099";

// Owned exclusively by this file's real-cancel-token test below — distinct
// from every other test file's date range so a parallel `deno test` run
// can never collide on the same slot.
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001";
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001";
const STAFF_ID = "d0000000-0000-4000-8000-000000000001";
const CANDIDATE_DATES = ["2027-01-04", "2027-01-11"];

async function createGuestBooking(): Promise<{ appointmentId: string; cancelToken: string } | null> {
  for (const date of CANDIDATE_DATES) {
    const availRes = await fetch(
      `${BASE}/get-availability?business_id=${BUSINESS_ID}&service_id=${SERVICE_ID}&date=${date}`,
      { headers: { apikey: ANON_KEY } },
    );
    const availBody = await availRes.json();
    const slots = Array.isArray(availBody.slots) ? availBody.slots : [];
    if (slots.length === 0) continue;

    const res = await fetch(`${BASE}/create-booking`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON_KEY },
      body: JSON.stringify({
        business_id: BUSINESS_ID,
        service_id: SERVICE_ID,
        staff_profile_id: STAFF_ID,
        date,
        time: slots[0].time,
        client: { name: "Get-Booking Test", email: `get_booking_test_${Date.now()}@example.com`, phone: "555-7777" },
        payment_method: "later",
      }),
    });
    if (res.status !== 201) continue;
    const body = await res.json();
    return { appointmentId: body.appointment_id, cancelToken: body.cancel_token };
  }
  return null;
}

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
  const res = await call({ id: TEST_APPT_ID });
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error.message, "Booking not found");
});

Deno.test("get-booking: real booking + wrong/garbage cancel_token → 404, not 200", async () => {
  const res = await call({ id: TEST_APPT_ID, cancel_token: "not-a-real-token" });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("get-booking: real booking + its own valid cancel_token → 200 with client details", async () => {
  // Generating a signed cancel token synchronously would need
  // BOOKING_CANCEL_TOKEN_SECRET, which ci.yml only writes into the
  // edge-runtime's own .env, not this outer `deno test` process's env —
  // but create-booking hands back a real, server-issued one in its own
  // response, so no env var (and no permanent skip) is actually needed.
  const booking = await createGuestBooking();
  if (!booking) {
    console.warn("No available slots for get-booking cancel-token test — reset DB with: supabase db reset");
    return;
  }
  const res = await call({ id: booking.appointmentId, cancel_token: booking.cancelToken });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.booking.id, booking.appointmentId);
});

Deno.test("get-booking: real booking + authenticated owner token for that business → 200, with staff embedded", async () => {
  const ownerToken = Deno.env.get("TEST_OWNER_TOKEN") || "";
  if (!ownerToken) return;
  const res = await call({ id: TEST_APPT_ID }, ownerToken);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.booking.id, TEST_APPT_ID);
  // Proves the staff:staff_profiles(...) embed actually resolved — this is
  // the exact query PostgREST 500'd on before the !staff_profile_id hint was
  // added (ambiguous against staff_profile_id_2/referrer_staff_id).
  assertEquals(body.booking.staff.display_name, "Fatima K.");
});

Deno.test("get-booking: real booking + authenticated client's own JWT (not owner/token) → 200", async () => {
  // ci.yml now mints a real client JWT (customer@test.com, linked in
  // seed.sql to TEST_APPT_ID's own client row) the same way it already
  // does for the owner and platform-admin tokens — this always runs now.
  const clientToken = Deno.env.get("TEST_CLIENT_TOKEN") || "";
  if (!clientToken) return;
  const res = await call({ id: TEST_APPT_ID }, clientToken);
  assertEquals(res.status, 200);
  await res.body?.cancel();
});
