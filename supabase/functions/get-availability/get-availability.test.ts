// supabase/functions/get-availability/get-availability.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // from seed
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001" // Knotless Braids from seed
const NON_WORKING_DAY = "2099-01-01" // unlikely to have slots
const PAST_DATE = "2000-01-01"

// S59: Africa/Kampala fixture (UTC+3, no DST) — seed.sql "Kampala test
// business" block. Working hours Monday (day_of_week=1) 09:00-17:00 local,
// 60-min service, 30-min slot grid → expected local slot range 09:00-16:00.
const KAMPALA_BUSINESS_ID = "b0000000-0000-4000-8000-000000000003"
const KAMPALA_SERVICE_ID = "c0000000-0000-4000-8000-000000000006"
const KAMPALA_MONDAY = "2026-10-05" // confirmed Monday

// Salon Seat Capacity sprint, Step Zero: the owner reported that with 2+
// staff who should have had genuinely free overlapping slots, the client
// booking flow still wouldn't let them book 2 appointments at the same
// time. Fatima K. and Regina M. (014_seed_data.sql) don't share a single
// service in staff_services — Fatima only has Knotless/Box Braids, Regina
// only has Loc Maintenance/Natural Hair Consultation — so today there is
// structurally only one eligible staff member per service. These tests
// prove that's the actual explanation (not a bug): get_available_slots
// correctly aggregates multiple staff once they're genuinely both assigned
// to the same service, and correctly shows only one when they aren't.
const STAFF_FATIMA_ID = "d0000000-0000-4000-8000-000000000001"
const STAFF_REGINA_ID = "d0000000-0000-4000-8000-000000000002"

// Afrotouch's business_settings.booking_future_days is only 60 (014_seed_data.sql)
// — unlike the Kampala fixture's 365 — so a hardcoded far-future date goes stale
// against a real clock and trips OUTSIDE_BOOKING_WINDOW. Compute relative to
// "now" instead, snapping past Sunday (non-working) like the "working day" test
// above already does.
function futureBusinessDate(minOffsetDays: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + minOffsetDays)
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const MULTI_STAFF_DATE = futureBusinessDate(40)

const SUPABASE_URL = "http://127.0.0.1:54321"
const SERVICE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
const REST_BASE = `${SUPABASE_URL}/rest/v1`
const SERVICE_HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
}

function callFn(params: Record<string, string>) {
  const url = new URL(`${BASE}/get-availability`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return fetch(url.toString(), { method: "GET", headers: { "apikey": ANON_KEY } })
}

async function grantServiceOffer(staffId: string, serviceId: string) {
  const res = await fetch(`${REST_BASE}/staff_services`, {
    method: "POST",
    headers: { ...SERVICE_HEADERS, Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({ staff_profile_id: staffId, service_id: serviceId, status: "accepted" }),
  })
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`Failed to grant service offer: ${res.status} ${await res.text()}`)
  }
  await res.body?.cancel().catch(() => {})
}

async function revokeServiceOffer(staffId: string, serviceId: string) {
  const res = await fetch(
    `${REST_BASE}/staff_services?staff_profile_id=eq.${staffId}&service_id=eq.${serviceId}`,
    { method: "DELETE", headers: SERVICE_HEADERS },
  )
  await res.body?.cancel().catch(() => {})
}

Deno.test("get-availability: missing business_id", async () => {
  const res = await callFn({ service_id: "foo", date: "2026-05-01" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("get-availability: missing service_id", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, date: "2026-05-01" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("get-availability: missing date", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, service_id: "foo" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})

Deno.test("get-availability: invalid date format", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, service_id: "foo", date: "notadate" })
  assertEquals(res.status, 400)
  await res.body?.cancel()
})


Deno.test("get-availability: working day", async () => {
  // Try multiple Mon-Sat dates 7-30 days out. Accept as soon as one returns slots.
  // Seed: staff work Mon-Sat (day_of_week 1-6), 10:00-19:00 Europe/Tallinn local.
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + 7);
  for (let offset = 0; offset < 30; offset++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + offset);
    const dow = d.getUTCDay(); // 0=Sun, 1-6=Mon-Sat
    if (dow === 0) continue; // skip Sunday (non-working)
    const dateStr = d.toISOString().slice(0, 10);
    const res = await callFn({ business_id: BUSINESS_ID, service_id: SERVICE_ID, date: dateStr });
    assertEquals(res.status, 200);
    const body = await res.json();
    if (Array.isArray(body.slots) && body.slots.length > 0) {
      // S59 regression proof: displayed slot labels are still exactly the
      // business-local range configured in staff_working_hours (10:00-19:00,
      // 180-min service → last slot 16:00), unchanged by the timezone fix —
      // only the underlying stored UTC instant moved.
      for (const slot of body.slots) {
        if (slot.time < "10:00" || slot.time > "16:00") {
          throw new Error(`Slot time ${slot.time} outside expected 10:00-16:00 Europe/Tallinn local range`);
        }
      }
      return; // success
    }
  }
  throw new Error("No working-day slots found in any Mon-Sat date over the next 37 days");
});

Deno.test("get-availability: Africa/Kampala business — slots are business-local, not UTC (S59)", async () => {
  const res = await callFn({
    business_id: KAMPALA_BUSINESS_ID,
    service_id: KAMPALA_SERVICE_ID,
    date: KAMPALA_MONDAY,
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  if (!Array.isArray(body.slots) || body.slots.length === 0) {
    throw new Error(`Expected slots for Kampala fixture on ${KAMPALA_MONDAY}, got: ${JSON.stringify(body)}`);
  }
  // Working hours 09:00-17:00 local, 60-min service, 30-min grid → 09:00-16:00.
  assertEquals(body.slots[0].time, "09:00");
  for (const slot of body.slots) {
    if (slot.time < "09:00" || slot.time > "16:00") {
      throw new Error(`Slot time ${slot.time} outside expected 09:00-16:00 Africa/Kampala local range`);
    }
  }
});

Deno.test("get-availability: non-working day", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, service_id: SERVICE_ID, date: NON_WORKING_DAY });
  assertEquals(res.status, 200);
  const body = await res.json();
  if (!Array.isArray(body.slots) || body.slots.length !== 0) throw new Error("Expected empty slots array");
});

Deno.test("get-availability: past date", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, service_id: SERVICE_ID, date: PAST_DATE });
  assertEquals(res.status, 200);
  const body = await res.json();
  if (!Array.isArray(body.slots) || body.slots.length !== 0) throw new Error("Expected empty slots array for past date");
});

// ── Seat Capacity Step Zero: staff_services eligibility, not a bug ─────────

Deno.test("get-availability: Knotless Braids has only one eligible staff (Fatima) today — Step Zero finding", async () => {
  const res = await callFn({ business_id: BUSINESS_ID, service_id: SERVICE_ID, date: MULTI_STAFF_DATE })
  assertEquals(res.status, 200)
  const body = await res.json()
  if (!Array.isArray(body.slots) || body.slots.length === 0) {
    throw new Error(`Expected slots on ${MULTI_STAFF_DATE}, got: ${JSON.stringify(body)}`)
  }
  for (const slot of body.slots) {
    assertEquals(slot.staff.length, 1)
    assertEquals(slot.staff[0].id, STAFF_FATIMA_ID)
  }
})

Deno.test("get-availability: aggregates both staff once they're genuinely both assigned to the same service", async () => {
  await grantServiceOffer(STAFF_REGINA_ID, SERVICE_ID)
  try {
    const res = await callFn({ business_id: BUSINESS_ID, service_id: SERVICE_ID, date: MULTI_STAFF_DATE })
    assertEquals(res.status, 200)
    const body = await res.json()
    const slot = (body.slots ?? []).find((s: { time: string }) => s.time === "10:00")
    if (!slot) throw new Error(`Expected a 10:00 slot, got: ${JSON.stringify(body.slots)}`)
    const staffIds = slot.staff.map((s: { id: string }) => s.id).sort()
    assertEquals(staffIds, [STAFF_FATIMA_ID, STAFF_REGINA_ID].sort())
  } finally {
    await revokeServiceOffer(STAFF_REGINA_ID, SERVICE_ID)
  }
})
