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

function callFn(params: Record<string, string>) {
  const url = new URL(`${BASE}/get-availability`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  return fetch(url.toString(), { method: "GET", headers: { "apikey": ANON_KEY } })
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
