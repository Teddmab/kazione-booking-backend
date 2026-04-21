// supabase/functions/services/services.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // from seed
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

async function callFn(method: string, token?: string, body?: any, params?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  let url = `${BASE}/services`
  if (params) {
    const u = new URL(url)
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
    url = u.toString()
  }
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

Deno.test("services: GET without auth", async () => {
  const res = await callFn("GET", undefined, undefined, { business_id: BUSINESS_ID })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("services: GET with owner token", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("GET", OWNER_TOKEN, undefined, { business_id: BUSINESS_ID })
  assertEquals(res.status, 200)
})

Deno.test("services: POST without auth", async () => {
  const res = await callFn("POST", undefined, { business_id: BUSINESS_ID, name: "Test Service", price: 10 })
  assertEquals(res.status, 401)
  await res.body?.cancel()
})

Deno.test("services: POST missing name", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("POST", OWNER_TOKEN, { business_id: BUSINESS_ID, price: 10 })
  assertEquals(res.status, 400)
})

Deno.test("services: POST missing price", async () => {
  if (!OWNER_TOKEN) return
  const res = await callFn("POST", OWNER_TOKEN, { business_id: BUSINESS_ID, name: "Test Service" })
  assertEquals(res.status, 400)
})


Deno.test("services: POST valid service", async () => {
  if (!OWNER_TOKEN) return;
  const uniqueName = `Test Service ${Date.now()}`;
  const res = await callFn("POST", OWNER_TOKEN, {
    business_id: BUSINESS_ID,
    name: uniqueName,
    price: 25.5
  });
  assertEquals(res.status, 201);
});

Deno.test("services: PATCH service from different business", async () => {
  if (!OWNER_TOKEN) return;
  // Create a service for BUSINESS_ID
  const uniqueName = `PatchTest ${Date.now()}`;
  const createRes = await callFn("POST", OWNER_TOKEN, {
    business_id: BUSINESS_ID,
    name: uniqueName,
    price: 15
  });
  if (createRes.status !== 201) return;
  const created = await createRes.json();
  const serviceId = created.id || (created.service && created.service.id);
  // Try to PATCH as if from a different business (simulate by using a random/invalid business_id)
  const res = await fetch(`${BASE}/services?id=${serviceId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OWNER_TOKEN}`
    },
    body: JSON.stringify({ business_id: "b0000000-0000-4000-8000-000000000099", name: "Hacked" })
  });
  if (![403, 404].includes(res.status)) throw new Error(`Expected 403 or 404, got ${res.status}`);
});
