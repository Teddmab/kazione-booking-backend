// supabase/functions/get-availability/get-availability.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // from seed
const SERVICE_ID = "c0000000-0000-4000-8000-000000000001" // Knotless Braids from seed
const NON_WORKING_DAY = "2099-01-01" // unlikely to have slots
const PAST_DATE = "2000-01-01"

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
  // Seed: staff work Mon-Sat (day_of_week 1-6), 10:00-19:00 UTC.
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
    if (Array.isArray(body.slots) && body.slots.length > 0) return; // success
  }
  throw new Error("No working-day slots found in any Mon-Sat date over the next 37 days");
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
