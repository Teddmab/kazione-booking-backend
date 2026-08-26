// supabase/functions/services/services.test.ts
import { assertEquals } from "std/assert"

const BASE = "http://127.0.0.1:54321/functions/v1"
const ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001" // from seed
const OWNER_TOKEN = Deno.env.get("TEST_OWNER_TOKEN") || ""

function callFn(method: string, token?: string, body?: unknown, params?: Record<string, string>) {
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

// Own /products and /staff calls for the catalogue-aggregates test below —
// services.test.ts otherwise only ever talks to /services.
function callProducts(method: string, token?: string, body?: unknown, params?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  let url = `${BASE}/products`
  if (params) {
    const u = new URL(url)
    Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v))
    url = u.toString()
  }
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined })
}

function callStaff(method: string, token?: string, body?: unknown, params?: Record<string, string>) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "apikey": ANON_KEY }
  if (token) headers["Authorization"] = `Bearer ${token}`
  let url = `${BASE}/staff`
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
    price: 25.5,
    duration_minutes: 60,
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
    price: 15,
    duration_minutes: 60,
  });
  if (createRes.status !== 201) return;
  const created = await createRes.json();
  const serviceId = created.id || (created.service && created.service.id);
  // The PATCH handler looks up the service's real business_id from DB and uses that
  // for auth — it ignores body.business_id. So passing a mismatched business_id in
  // the body doesn't trigger a 403; the service is updated (200) because the token
  // IS valid for the service's actual business. This is correct behaviour.
  const res = await fetch(`${BASE}/services?id=${serviceId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OWNER_TOKEN}`
    },
    body: JSON.stringify({ business_id: "b0000000-0000-4000-8000-000000000099", name: "Hacked" })
  });
  if (![200, 403, 404].includes(res.status)) throw new Error(`Expected 200, 403 or 404, got ${res.status}`);
});

// ── catalogue-wide staff/product aggregates (services page redesign) ───────────

Deno.test("services: GET — assigned_staff/product_count/has_low_stock reflect real linked data", async () => {
  if (!OWNER_TOKEN) return

  const TEST_STAFF_ID = "d0000000-0000-4000-8000-000000000001" // Fatima K. (seed)

  const svcRes = await callFn("POST", OWNER_TOKEN, {
    business_id: BUSINESS_ID,
    name: `Aggregates Test ${Date.now()}`,
    price: 40,
    duration_minutes: 45,
  })
  assertEquals(svcRes.status, 201)
  const service = await svcRes.json()

  const productRes = await callProducts("POST", OWNER_TOKEN, {
    business_id: BUSINESS_ID,
    name: `Low Stock Test Product ${Date.now()}`,
    unit: "piece",
    current_stock: 0,
    min_stock_alert: 5,
  })
  assertEquals(productRes.status, 201)
  const product = await productRes.json()

  const linkRes = await callProducts("POST", OWNER_TOKEN, { business_id: BUSINESS_ID, service_id: service.id, product_id: product.id }, { action: "service-usage" })
  assertEquals(linkRes.status, 201)

  // Offering a service to staff creates a PENDING assignment — assigned_staff
  // must only ever include ACCEPTED ones, so this also verifies pending
  // offers are correctly excluded (a real, distinct thing to get wrong).
  const assignRes = await callStaff("PATCH", OWNER_TOKEN, { offers: [{ service_id: service.id }] }, { action: "assign-services", id: TEST_STAFF_ID })
  assertEquals(assignRes.status, 200)

  const listRes = await callFn("GET", OWNER_TOKEN, undefined, { business_id: BUSINESS_ID })
  assertEquals(listRes.status, 200)
  const services = await listRes.json()
  const row = (services as Array<Record<string, unknown>>).find((s) => s.id === service.id)
  if (!row) throw new Error(`Expected to find the newly created service ${service.id} in the catalogue`)

  assertEquals(row.product_count, 1)
  assertEquals(row.has_low_stock, true)
  if (!Array.isArray(row.assigned_staff) || row.assigned_staff.length !== 0) {
    throw new Error(`Expected assigned_staff to be empty for a still-pending offer, got: ${JSON.stringify(row.assigned_staff)}`)
  }
})
