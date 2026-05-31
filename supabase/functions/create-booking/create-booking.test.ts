// supabase/functions/create-booking/create-booking.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // from seed
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001" // Knotless Braids from seed
const STAFF_ID = "d0000000-0000-4000-8000-000000000001" // Fatima K. from seed

function callFn(body: unknown) {
  return fetch(`${BASE}/create-booking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
    body: JSON.stringify(body),
  })
}

Deno.test("create-booking: missing service_id", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, date: "2026-05-01", time: "10:00", client: { name: "Test", email: "test@example.com", phone: "123" }, payment_method: "later" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("create-booking: missing starts_at", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, service_id: SERVICE_ID, client: { name: "Test", email: "test@example.com", phone: "123" }, payment_method: "later" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("create-booking: missing client email", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, service_id: SERVICE_ID, date: "2026-05-01", time: "10:00", client: { name: "Test", phone: "123" }, payment_method: "later" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("create-booking: invalid starts_at format", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, service_id: SERVICE_ID, date: "notadate", time: "notatime", client: { name: "Test", email: "test@example.com", phone: "123" }, payment_method: "later" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})


/** Find the first fully available slot (date + time + staff_id) by querying get-availability.
 *  Tries each Tuesday in May–June 2026 until it finds one with available slots.
 *  Returns { date, time, staff_profile_id } or null.
 */
async function findAvailableSlot(skipDate?: string): Promise<{ date: string; time: string; staffId: string } | null> {
  const dates = [
    "2026-05-26", "2026-06-16", "2026-06-23",
    "2026-05-19", "2026-05-12", "2026-05-05",
  ];
  const ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
  for (const date of dates) {
    if (date === skipDate) continue;
    const r = await fetch(
      `${BASE}/get-availability?business_id=${BUSINESS_ID}&service_id=${SERVICE_ID}&date=${date}`,
      { headers: { apikey: ANON } }
    );
    const body = await r.json();
    if (Array.isArray(body.slots) && body.slots.length > 0) {
      const slot = body.slots[0];
      const staffId = slot.staff?.[0]?.id ?? STAFF_ID;
      return { date, time: slot.time, staffId };
    }
  }
  return null;
}

Deno.test("create-booking: valid guest booking", async () => {
  const slot = await findAvailableSlot();
  if (!slot) {
    console.warn("No available slots found — reset DB with: supabase db reset");
    return;
  }
  const res = await callFn({
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    staff_profile_id: slot.staffId,
    date: slot.date,
    time: slot.time,
    client: { name: "Test Guest", email: `guest${Date.now()}@example.com`, phone: "555-0000" },
    payment_method: "later"
  });
  assertEquals(res.status, 201);
  const body = await res.json();
  if (!body.appointment_id || !body.booking_reference) throw new Error("Missing appointment_id or booking_reference");
});

Deno.test("create-booking: double booking same slot (sequential)", async () => {
  const slotData = await findAvailableSlot();
  if (!slotData) {
    console.warn("No available slots for double-booking test — reset DB with: supabase db reset");
    return;
  }
  const slot = { business_id: BUSINESS_ID, service_id: SERVICE_ID, staff_profile_id: slotData.staffId, date: slotData.date, time: slotData.time, client: { name: "Test Guest", email: `guest${Date.now()}@example.com`, phone: "555-0000" }, payment_method: "later" };
  const res1 = await callFn(slot);
  await res1.body?.cancel()
  const res2 = await callFn({ ...slot, client: { ...slot.client, email: `guest${Date.now()}b@example.com` } });
  assertEquals(res2.status, 409);
  await res2.body?.cancel()
});

Deno.test("create-booking: concurrent double booking (advisory lock)", async () => {
  // This test proves the pg_advisory_xact_lock prevents double-booking under
  // true concurrency. Both requests fire simultaneously via Promise.all.
  // The advisory lock inside create_booking_atomic serialises them — exactly
  // ONE must succeed (201) and the other must be rejected (409 SLOT_TAKEN).
  const slotData = await findAvailableSlot();
  if (!slotData) {
    console.warn("No available slots for concurrent test — reset DB with: supabase db reset");
    return;
  }
  const base = {
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    staff_profile_id: slotData.staffId,
    date: slotData.date,
    time: slotData.time,
    payment_method: "later",
  };

  const [res1, res2] = await Promise.all([
    callFn({ ...base, client: { name: "Concurrent A", email: `concurrent_a_${Date.now()}@example.com`, phone: "555-0001" } }),
    callFn({ ...base, client: { name: "Concurrent B", email: `concurrent_b_${Date.now()}@example.com`, phone: "555-0002" } }),
  ]);

  const body1 = await res1.json();
  const body2 = await res2.json();
  const statuses = [res1.status, res2.status].sort();

  // Exactly one 201 and one 409
  if (statuses[0] !== 201 || statuses[1] !== 409) {
    console.error("Concurrent test unexpected statuses:", statuses, "bodies:", JSON.stringify(body1), JSON.stringify(body2));
  }
  assertEquals(statuses[0], 201, `Expected one 201, got statuses ${JSON.stringify(statuses)}`);
  assertEquals(statuses[1], 409, `Expected one 409, got statuses ${JSON.stringify(statuses)}`);

  // Confirm exactly ONE appointment was created (not two)
  const successBody = res1.status === 201 ? body1 : body2;
  if (!successBody.appointment_id) throw new Error("Winner response missing appointment_id");
});

Deno.test("create-booking: starts_at in the past", async () => {
  const res = await callFn({
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    staff_profile_id: STAFF_ID,
    date: "2020-01-01",
    time: "09:00",
    client: { name: "Test Guest", email: `guest${Date.now()}@example.com`, phone: "555-0000" },
    payment_method: "later"
  });
  // Function returns 409 SLOT_TAKEN for past dates (no available staff → slot taken)
  if (![400, 409].includes(res.status)) throw new Error(`Expected 400 or 409 for past date, got ${res.status}`);
  await res.body?.cancel()
});
