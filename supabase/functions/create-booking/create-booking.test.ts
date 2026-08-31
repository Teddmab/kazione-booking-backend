// supabase/functions/create-booking/create-booking.test.ts
import { assertEquals } from "std/assert";

const BASE = "http://127.0.0.1:54321/functions/v1";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001"; // from seed
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001"; // Knotless Braids from seed
const STAFF_ID = "d0000000-0000-4000-8000-000000000001"; // Fatima K. from seed
const STAFF_ID_2 = "d0000000-0000-4000-8000-000000000002"; // Regina M. from seed

// S59: Africa/Kampala fixture (UTC+3, no DST) — proves date+time are
// interpreted as the business's local wall-clock, not UTC.
const SUPABASE_URL = "http://127.0.0.1:54321";
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const KAMPALA_BUSINESS_ID = "b0000000-0000-4000-8000-000000000003";
const KAMPALA_SERVICE_ID = "c0000000-0000-4000-8000-000000000006";
// A different Monday than get-availability.test.ts's KAMPALA_MONDAY
// (2026-10-05), so booking here can never collide with that file's
// slots[0]==="09:00" assertion when tests run in the same CI pass.
const KAMPALA_BOOKING_DATE = "2026-10-12";

function callFn(body: unknown) {
  return fetch(`${BASE}/create-booking`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": ANON_KEY },
    body: JSON.stringify(body),
  });
}

Deno.test("create-booking: missing service_id", async () => {
  const res = await callFn({
    business_id: BUSINESS_ID,
    date: "2026-05-01",
    time: "10:00",
    client: { name: "Test", email: "test@example.com", phone: "123" },
    payment_method: "later",
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("create-booking: missing starts_at", async () => {
  const res = await callFn({
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    client: { name: "Test", email: "test@example.com", phone: "123" },
    payment_method: "later",
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("create-booking: missing client email when phone is provided", async () => {
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
    client: { name: "Test", phone: "123" },
    payment_method: "later",
  });
  assertEquals(res.status, 201);
  const body = await res.json();
  if (!body.appointment_id || !body.booking_reference) {
    throw new Error("Missing appointment_id or booking_reference");
  }
});

Deno.test("create-booking: missing client contact returns 400", async () => {
  const res = await callFn({
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    date: "2026-05-01",
    time: "10:00",
    client: { name: "", email: "", phone: "" },
    payment_method: "later",
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("create-booking: invalid starts_at format", async () => {
  const res = await callFn({
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    date: "notadate",
    time: "notatime",
    client: { name: "Test", email: "test@example.com", phone: "123" },
    payment_method: "later",
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

/** Find the first fully available slot (date + time + staff_id) by querying get-availability.
 *  Tries each Tuesday in May–June 2026 until it finds one with available slots.
 *  Returns { date, time, staff_profile_id } or null.
 */
async function findAvailableSlot(
  skipDate?: string,
): Promise<{ date: string; time: string; staffId: string } | null> {
  const dates = [
    "2026-06-10",
    "2026-06-17",
    "2026-06-24",
    "2026-07-01",
    "2026-07-08",
    "2026-07-15",
    "2026-07-22",
    "2026-07-29",
    "2026-08-05",
    "2026-08-12",
  ];
  const ANON =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
  for (const date of dates) {
    if (date === skipDate) continue;
    const r = await fetch(
      `${BASE}/get-availability?business_id=${BUSINESS_ID}&service_id=${SERVICE_ID}&date=${date}`,
      { headers: { apikey: ANON } },
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
    client: {
      name: "Test Guest",
      email: `guest${Date.now()}@example.com`,
      phone: "555-0000",
    },
    payment_method: "later",
  });
  assertEquals(res.status, 201);
  const body = await res.json();
  if (!body.appointment_id || !body.booking_reference) {
    throw new Error("Missing appointment_id or booking_reference");
  }
});

Deno.test("create-booking: explicit staff_profile_id is actually persisted on the appointment", async () => {
  // Regression test: the marketplace booking form (SalonBooking.tsx) was
  // built the whole booking payload WITHOUT ever including staff_profile_id
  // — every booking silently went through the "no preference" path
  // regardless of what staff the client actually picked in the UI, and the
  // appointment always came out unassigned. Caught via a real bug report
  // ("book with a specific staff... booking still not automatically
  // assigned"), not by this test suite, because no existing test asserted
  // on the created appointment's staff_profile_id — only on the HTTP status.
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
    client: {
      name: "Test Guest — explicit staff",
      email: `guest-explicit-${Date.now()}@example.com`,
      phone: "555-0001",
    },
    payment_method: "later",
  });
  assertEquals(res.status, 201);
  const body = await res.json();

  const row = await fetch(
    `${SUPABASE_URL}/rest/v1/appointments?id=eq.${body.appointment_id}&select=staff_profile_id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const rows = await row.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Appointment row not found");
  assertEquals(rows[0].staff_profile_id, slot.staffId);
});

Deno.test("create-booking: no staff preference → appointment created unassigned (staff_profile_id null)", async () => {
  const slot = await findAvailableSlot();
  if (!slot) {
    console.warn("No available slots found — reset DB with: supabase db reset");
    return;
  }
  const res = await callFn({
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    // No staff_profile_id — client didn't request a specific staff member.
    date: slot.date,
    time: slot.time,
    client: {
      name: "Test Guest — no preference",
      email: `guest-nopref-${Date.now()}@example.com`,
      phone: "555-0002",
    },
    payment_method: "later",
  });
  assertEquals(res.status, 201);
  const body = await res.json();

  const row = await fetch(
    `${SUPABASE_URL}/rest/v1/appointments?id=eq.${body.appointment_id}&select=staff_profile_id`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const rows = await row.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("Appointment row not found");
  assertEquals(rows[0].staff_profile_id, null);
});

Deno.test("create-booking: double booking same slot (sequential)", async () => {
  const slotData = await findAvailableSlot();
  if (!slotData) {
    console.warn(
      "No available slots for double-booking test — reset DB with: supabase db reset",
    );
    return;
  }
  const slot = {
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    staff_profile_id: slotData.staffId,
    date: slotData.date,
    time: slotData.time,
    client: {
      name: "Test Guest",
      email: `guest${Date.now()}@example.com`,
      phone: "555-0000",
    },
    payment_method: "later",
  };
  const res1 = await callFn(slot);
  await res1.body?.cancel();
  const res2 = await callFn({
    ...slot,
    client: { ...slot.client, email: `guest${Date.now()}b@example.com` },
  });
  assertEquals(res2.status, 409);
  await res2.body?.cancel();
});

Deno.test("create-booking: concurrent double booking (advisory lock)", async () => {
  // This test proves the pg_advisory_xact_lock prevents double-booking under
  // true concurrency. Both requests fire simultaneously via Promise.all.
  // The advisory lock inside create_booking_atomic serialises them — exactly
  // ONE must succeed (201) and the other must be rejected (409 SLOT_TAKEN).
  const slotData = await findAvailableSlot();
  if (!slotData) {
    console.warn(
      "No available slots for concurrent test — reset DB with: supabase db reset",
    );
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
    callFn({
      ...base,
      client: {
        name: "Concurrent A",
        email: `concurrent_a_${Date.now()}@example.com`,
        phone: "555-0001",
      },
    }),
    callFn({
      ...base,
      client: {
        name: "Concurrent B",
        email: `concurrent_b_${Date.now()}@example.com`,
        phone: "555-0002",
      },
    }),
  ]);

  const body1 = await res1.json();
  const body2 = await res2.json();
  const statuses = [res1.status, res2.status].sort();

  // Exactly one 201 and one 409
  if (statuses[0] !== 201 || statuses[1] !== 409) {
    console.error(
      "Concurrent test unexpected statuses:",
      statuses,
      "bodies:",
      JSON.stringify(body1),
      JSON.stringify(body2),
    );
  }
  assertEquals(
    statuses[0],
    201,
    `Expected one 201, got statuses ${JSON.stringify(statuses)}`,
  );
  assertEquals(
    statuses[1],
    409,
    `Expected one 409, got statuses ${JSON.stringify(statuses)}`,
  );

  // Confirm exactly ONE appointment was created (not two)
  const successBody = res1.status === 201 ? body1 : body2;
  if (!successBody.appointment_id) {
    throw new Error("Winner response missing appointment_id");
  }
});

Deno.test("create-booking: starts_at in the past", async () => {
  const res = await callFn({
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    staff_profile_id: STAFF_ID,
    date: "2020-01-01",
    time: "09:00",
    client: {
      name: "Test Guest",
      email: `guest${Date.now()}@example.com`,
      phone: "555-0000",
    },
    payment_method: "later",
  });
  // Function returns 409 SLOT_TAKEN for past dates (no available staff → slot taken)
  if (![400, 409].includes(res.status)) {
    throw new Error(`Expected 400 or 409 for past date, got ${res.status}`);
  }
  await res.body?.cancel();
});

Deno.test("create-booking: Africa/Kampala 09:00 local books as 06:00 UTC (S59)", async () => {
  const res = await callFn({
    business_id: KAMPALA_BUSINESS_ID,
    service_id: KAMPALA_SERVICE_ID,
    date: KAMPALA_BOOKING_DATE,
    time: "09:00",
    client: {
      name: "Kampala Test Guest",
      email: `kampala_test_${Date.now()}@example.com`,
      phone: "555-0001",
    },
    payment_method: "later",
  });
  assertEquals(res.status, 201);
  const body = await res.json();
  if (!body.appointment_id) throw new Error("Expected appointment_id in response");

  const dbRes = await fetch(
    `${SUPABASE_URL}/rest/v1/appointments?id=eq.${body.appointment_id}&select=starts_at`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const rows = await dbRes.json();
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`Expected exactly one appointment row, got: ${JSON.stringify(rows)}`);
  }
  // 09:00 Africa/Kampala local (UTC+3, no DST) = 06:00 UTC — the concrete
  // proof that date+time were converted through the business's IANA
  // timezone before storage, not stored as if they were literal UTC digits.
  const storedStartsAt = new Date(rows[0].starts_at).toISOString();
  assertEquals(storedStartsAt, `${KAMPALA_BOOKING_DATE}T06:00:00.000Z`);
});

// ── Seat Capacity Step Zero: staff_services eligibility, not a bug ─────────
// The owner reported that with 2+ staff who should have had genuinely free
// overlapping slots, the client booking flow still wouldn't let them book 2
// appointments at the same time. Fatima K. and Regina M. (014_seed_data.sql)
// don't share a single service in staff_services — so today there is
// structurally only one eligible staff member per service. These two tests
// reproduce the owner's exact scenario (2 concurrent bookings, same
// service, same time) both with and without a shared staff assignment,
// proving the public booking path itself has no bug.

async function grantServiceOffer(staffId: string, serviceId: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/staff_services`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: JSON.stringify({ staff_profile_id: staffId, service_id: serviceId, status: "accepted" }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Failed to grant service offer: ${res.status} ${await res.text()}`);
  }
  await res.body?.cancel().catch(() => {});
}

async function revokeServiceOffer(staffId: string, serviceId: string) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/staff_services?staff_profile_id=eq.${staffId}&service_id=eq.${serviceId}`,
    { method: "DELETE", headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  await res.body?.cancel().catch(() => {});
}

Deno.test("create-booking: 2 clients CAN book the same service+time with different staff once both staff actually offer it", async () => {
  const date = "2026-11-16"; // Monday; unused by any other *.test.ts fixture
  await grantServiceOffer(STAFF_ID_2, SERVICE_ID);
  try {
    const res1 = await callFn({
      business_id: BUSINESS_ID,
      service_id: SERVICE_ID,
      staff_profile_id: STAFF_ID,
      date,
      time: "10:00",
      client: { name: "Multi Staff Client 1", email: "multi-staff-1@test.kazione.local" },
      payment_method: "later",
    });
    assertEquals(res1.status, 201);
    await res1.json();

    const res2 = await callFn({
      business_id: BUSINESS_ID,
      service_id: SERVICE_ID,
      staff_profile_id: STAFF_ID_2,
      date,
      time: "10:00",
      client: { name: "Multi Staff Client 2", email: "multi-staff-2@test.kazione.local" },
      payment_method: "later",
    });
    assertEquals(res2.status, 201);
    await res2.json();
  } finally {
    await revokeServiceOffer(STAFF_ID_2, SERVICE_ID);
  }
});

Deno.test("create-booking: without a shared staff assignment, a 2nd booking for the same service+time has no eligible staff left (matches the owner-reported behaviour — not a bug)", async () => {
  // Regina does not offer Knotless Braids in seed data — Fatima is the only
  // eligible staff, so once she is booked at this time the same service+time
  // has no one left to serve it.
  const date = "2026-11-17"; // Tuesday; separate date from the fixture test above
  const res1 = await callFn({
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID,
    staff_profile_id: STAFF_ID,
    date,
    time: "10:00",
    client: { name: "Solo Staff Client 1", email: "solo-staff-1@test.kazione.local" },
    payment_method: "later",
  });
  assertEquals(res1.status, 201);
  await res1.json();

  const res2 = await callFn({
    business_id: BUSINESS_ID,
    service_id: SERVICE_ID, // no staff_profile_id — "any available"
    date,
    time: "10:00",
    client: { name: "Solo Staff Client 2", email: "solo-staff-2@test.kazione.local" },
    payment_method: "later",
  });
  assertEquals(res2.status, 409);
  const body = await res2.json();
  assertEquals(body.error?.code, "SLOT_TAKEN");
});
