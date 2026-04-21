// supabase/functions/pawapay-payment/pawapay-payment.test.ts
import { assertEquals, assertMatch } from "https://deno.land/std/testing/asserts.ts";

const BASE = "http://127.0.0.1:54321/functions/v1";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// Seed data constants
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001";

async function callPayment(body: Record<string, unknown>) {
  return fetch(`${BASE}/pawapay-payment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Validation tests — these run without a live PawaPay key
// ---------------------------------------------------------------------------

Deno.test("pawapay-payment: GET method returns 400", async () => {
  const res = await fetch(`${BASE}/pawapay-payment`, {
    headers: { apikey: ANON_KEY },
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("pawapay-payment: missing appointmentId returns 422", async () => {
  const res = await callPayment({
    businessId: BUSINESS_ID,
    phone: "+256701234567",
    operatorCode: "MTN_MOMO_UGA",
    amount: "25.00",
    currency: "UGX",
  });
  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.error.code, "VALIDATION_ERROR");
});

Deno.test("pawapay-payment: invalid phone format returns 422", async () => {
  const res = await callPayment({
    appointmentId: "00000000-0000-4000-8000-000000000001",
    businessId: BUSINESS_ID,
    phone: "0701234567", // missing + prefix
    operatorCode: "MTN_MOMO_UGA",
    amount: "25.00",
    currency: "UGX",
  });
  assertEquals(res.status, 422);
  const body = await res.json();
  assertMatch(body.error.message, /E\.164/i);
});

Deno.test("pawapay-payment: invalid operatorCode returns 422", async () => {
  const res = await callPayment({
    appointmentId: "00000000-0000-4000-8000-000000000001",
    businessId: BUSINESS_ID,
    phone: "+256701234567",
    operatorCode: "INVALID_OP",
    amount: "25.00",
    currency: "UGX",
  });
  assertEquals(res.status, 422);
  const body = await res.json();
  assertMatch(body.error.message, /operatorCode must be one of/i);
});

Deno.test("pawapay-payment: zero amount returns 422", async () => {
  const res = await callPayment({
    appointmentId: "00000000-0000-4000-8000-000000000001",
    businessId: BUSINESS_ID,
    phone: "+256701234567",
    operatorCode: "MTN_MOMO_UGA",
    amount: "0",
    currency: "UGX",
  });
  assertEquals(res.status, 422);
  await res.body?.cancel();
});

Deno.test("pawapay-payment: invalid currency (not 3 chars) returns 422", async () => {
  const res = await callPayment({
    appointmentId: "00000000-0000-4000-8000-000000000001",
    businessId: BUSINESS_ID,
    phone: "+256701234567",
    operatorCode: "MTN_MOMO_UGA",
    amount: "25.00",
    currency: "UGXX",
  });
  assertEquals(res.status, 422);
  await res.body?.cancel();
});

Deno.test("pawapay-payment: appointment not found returns 404", async () => {
  const res = await callPayment({
    appointmentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    businessId: BUSINESS_ID,
    phone: "+256701234567",
    operatorCode: "MTN_MOMO_UGA",
    amount: "25.00",
    currency: "UGX",
  });
  // Appointment lookup happens before the PawaPay API call
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("pawapay-payment: valid request requires PAWAPAY_API_KEY (sandbox test)", async () => {
  const apiKey = Deno.env.get("PAWAPAY_API_KEY");
  if (!apiKey) {
    console.log("  [SKIP] PAWAPAY_API_KEY not set — skipping live sandbox test");
    return;
  }
  // With a real API key and a non-existent appointment, should get 404 (not 500)
  const res = await callPayment({
    appointmentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    businessId: BUSINESS_ID,
    phone: "+256701234567",
    operatorCode: "MTN_MOMO_UGA",
    amount: "25.00",
    currency: "UGX",
  });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});
