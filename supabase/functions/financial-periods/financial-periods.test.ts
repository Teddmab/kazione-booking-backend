// supabase/functions/financial-periods/financial-periods.test.ts
//
// Covers the month-close lock: closing a month must block writes to
// owner-editable bookkeeping records dated in it (here, expenses), and
// reopening must restore normal write access. Uses a month far outside any
// other test's date range (2020-01) so this test can't collide with fixture
// data created elsewhere, and cleans up after itself so re-runs are
// idempotent.
//
// Fixture IDs are deterministic seed data (supabase/seed.sql), not secrets —
// hardcoded the same way as clients.test.ts.
import { assertEquals } from "std/assert";

const BASE = "http://127.0.0.1:54321/functions/v1";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// Seed fixtures — Afrotouch Tallinn (owner@afrotouch.ee's business).
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001";

const TEST_MONTH = "2020-01";
const TEST_DATE = "2020-01-15";

function call(base: string, method: string, params: Record<string, string>, token?: string, body?: unknown) {
  const url = new URL(base);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: ANON_KEY };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function periodsCall(method: string, params: Record<string, string>, token?: string, body?: unknown) {
  return call(`${BASE}/financial-periods`, method, params, token, body);
}

function financeCall(method: string, params: Record<string, string>, token?: string, body?: unknown) {
  return call(`${BASE}/finance`, method, params, token, body);
}

Deno.test("financial-periods: GET status with no auth → 401 or 403", async () => {
  const res = await periodsCall("GET", { action: "status", business_id: BUSINESS_ID, month: TEST_MONTH });
  if (![401, 403].includes(res.status)) throw new Error(`Expected 401 or 403, got ${res.status}`);
  await res.body?.cancel();
});

Deno.test("financial-periods: close blocks writes in that month; reopen restores them", async () => {
  const ownerToken = Deno.env.get("TEST_OWNER_TOKEN") || "";
  if (!ownerToken) return;

  // Ensure a clean starting state regardless of prior test runs.
  const reopenFirst = await periodsCall("POST", { action: "reopen" }, ownerToken, { business_id: BUSINESS_ID, month: TEST_MONTH });
  await reopenFirst.body?.cancel();

  // Status should report open with no lock.
  const statusBefore = await periodsCall("GET", { action: "status", business_id: BUSINESS_ID, month: TEST_MONTH }, ownerToken);
  assertEquals(statusBefore.status, 200);
  const statusBeforeBody = await statusBefore.json();
  assertEquals(statusBeforeBody.status, "open");

  // Close the month.
  const closeRes = await periodsCall("POST", { action: "close" }, ownerToken, { business_id: BUSINESS_ID, month: TEST_MONTH, note: "test close" });
  assertEquals(closeRes.status, 201);
  const closeBody = await closeRes.json();
  assertEquals(closeBody.status, "closed");

  // Closing again should 409.
  const doubleCloseRes = await periodsCall("POST", { action: "close" }, ownerToken, { business_id: BUSINESS_ID, month: TEST_MONTH });
  assertEquals(doubleCloseRes.status, 409);
  const doubleCloseBody = await doubleCloseRes.json();
  assertEquals(doubleCloseBody.error.code, "ALREADY_CLOSED");

  // An expense dated in the closed month must be rejected.
  const blockedExpenseRes = await financeCall("POST", { action: "expense" }, ownerToken, {
    business_id: BUSINESS_ID,
    category: "other",
    description: "MONTH_LOCKED regression test",
    amount: 12.34,
    date: TEST_DATE,
  });
  assertEquals(blockedExpenseRes.status, 409);
  const blockedExpenseBody = await blockedExpenseRes.json();
  assertEquals(blockedExpenseBody.error.code, "MONTH_LOCKED");

  // Reopen the month.
  const reopenRes = await periodsCall("POST", { action: "reopen" }, ownerToken, { business_id: BUSINESS_ID, month: TEST_MONTH, reason: "test reopen" });
  assertEquals(reopenRes.status, 200);
  const reopenBody = await reopenRes.json();
  assertEquals(reopenBody.status, "open");

  // Reopening again (already open) should 409.
  const doubleReopenRes = await periodsCall("POST", { action: "reopen" }, ownerToken, { business_id: BUSINESS_ID, month: TEST_MONTH });
  assertEquals(doubleReopenRes.status, 409);
  const doubleReopenBody = await doubleReopenRes.json();
  assertEquals(doubleReopenBody.error.code, "ALREADY_OPEN");

  // The same expense write must now succeed — and clean it up afterward.
  const allowedExpenseRes = await financeCall("POST", { action: "expense" }, ownerToken, {
    business_id: BUSINESS_ID,
    category: "other",
    description: "MONTH_LOCKED regression test",
    amount: 12.34,
    date: TEST_DATE,
  });
  assertEquals(allowedExpenseRes.status, 201);
  const allowedExpenseBody = await allowedExpenseRes.json();

  const cleanupRes = await financeCall("DELETE", { id: allowedExpenseBody.id }, ownerToken);
  assertEquals(cleanupRes.status, 204);
});
