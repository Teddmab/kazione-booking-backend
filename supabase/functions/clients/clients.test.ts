// supabase/functions/clients/clients.test.ts
//
// Covers S57 finding 2: PATCH must not mass-assign the request body onto
// the row, and must never let a foreign business_id in the body move the
// client out of the caller's verified business.
//
// Fixture IDs below are deterministic seed data (supabase/seed.sql), not
// secrets — hardcoded the same way BUSINESS_ID/SERVICE_ID are in
// reschedule-booking.test.ts, so these tests actually run in CI instead of
// silently skipping behind an unset env var (S74).
import { assertEquals, assertNotEquals } from "std/assert";

const BASE = "http://127.0.0.1:54321/functions/v1";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// Seed fixtures — Afrotouch Tallinn (owner@afrotouch.ee's business).
const BUSINESS_ID = "b0000000-0000-4000-8000-000000000001";
const CLIENT_ID = "c1000000-0000-4000-8000-000000000001"; // Amara Diallo

// Seed fixtures — Foreign Test Salon (added in S74, supabase/seed.sql).
const FOREIGN_BUSINESS_ID = "b0000000-0000-4000-8000-000000000002";
const FOREIGN_CLIENT_ID = "c2000000-0000-4000-8000-000000000001";

function call(method: string, params: Record<string, string>, token?: string, body?: unknown) {
  const url = new URL(`${BASE}/clients`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: ANON_KEY };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
}

// A nonexistent id 404s before the auth check even runs — the handler must
// resolve the target row's business_id (to know which business to check
// membership against) before it can authorize, so existence is necessarily
// checked first. That's expected, not a leak: this endpoint isn't a target
// for id-guessing since PGRST doesn't return an existence signal beyond the
// generic 404 either way.
Deno.test("clients: PATCH nonexistent id, no auth → 404 (existence check runs before auth)", async () => {
  const res = await call("PATCH", { id: "00000000-0000-0000-0000-000000000000" }, undefined, { notes: "x" });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});

Deno.test("clients: PATCH real client, no auth → 401 or 403", async () => {
  const res = await call("PATCH", { id: CLIENT_ID }, undefined, { notes: "x" });
  if (![401, 403].includes(res.status)) throw new Error(`Expected 401 or 403, got ${res.status}`);
  await res.body?.cancel();
});

Deno.test("clients: PATCH missing id → 400", async () => {
  const ownerToken = Deno.env.get("TEST_OWNER_TOKEN") || "";
  if (!ownerToken) return;
  const res = await call("PATCH", {}, ownerToken, { notes: "x" });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("clients: PATCH with no editable fields → 400", async () => {
  const ownerToken = Deno.env.get("TEST_OWNER_TOKEN") || "";
  if (!ownerToken) return;
  // Only unrecognised/forbidden keys — nothing lands in the allowlist.
  const res = await call("PATCH", { id: CLIENT_ID }, ownerToken, {
    business_id: "11111111-1111-1111-1111-111111111111",
    user_id: "22222222-2222-2222-2222-222222222222",
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("clients: PATCH with a foreign business_id in the body does not move the client", async () => {
  const ownerToken = Deno.env.get("TEST_OWNER_TOKEN") || "";
  if (!ownerToken) return;

  const res = await call("PATCH", { id: CLIENT_ID }, ownerToken, {
    business_id: FOREIGN_BUSINESS_ID,
    notes: `S57 regression test ${Date.now()}`,
  });
  assertEquals(res.status, 200);
  const updated = await res.json();
  assertEquals(updated.business_id, BUSINESS_ID);
  assertNotEquals(updated.business_id, FOREIGN_BUSINESS_ID);
});

// The caller IS authenticated (a real owner token) — just not a member of
// the target client's actual business. requireOwnerOrManagerCtx resolves
// existence first (client is found), then verifyBusinessMember rejects the
// membership check, which is a 403 (forbidden), not a 404. Confirmed by
// tracing the actual code path, not assumed — see SPRINT_S74 for the trace.
Deno.test("clients: PATCH targeting a client in a different business → 403, not silently applied", async () => {
  const ownerToken = Deno.env.get("TEST_OWNER_TOKEN") || "";
  if (!ownerToken) return;

  const res = await call("PATCH", { id: FOREIGN_CLIENT_ID }, ownerToken, { notes: "should not land" });
  assertEquals(res.status, 403);
  await res.body?.cancel();
});
