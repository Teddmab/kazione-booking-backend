// supabase/functions/clients/clients.test.ts
//
// Covers S57 finding 2: PATCH must not mass-assign the request body onto
// the row, and must never let a foreign business_id in the body move the
// client out of the caller's verified business.
import { assertEquals, assertNotEquals } from "std/assert";

const BASE = "http://127.0.0.1:54321/functions/v1";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function call(method: string, params: Record<string, string>, token?: string, body?: unknown) {
  const url = new URL(`${BASE}/clients`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers: Record<string, string> = { "Content-Type": "application/json", apikey: ANON_KEY };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return fetch(url.toString(), { method, headers, body: body ? JSON.stringify(body) : undefined });
}

Deno.test("clients: PATCH without auth → 401 or 403", async () => {
  const res = await call("PATCH", { id: "00000000-0000-0000-0000-000000000000" }, undefined, { notes: "x" });
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
  const clientId = Deno.env.get("TEST_CLIENT_ID") || "";
  if (!ownerToken || !clientId) return;
  // Only unrecognised/forbidden keys — nothing lands in the allowlist.
  const res = await call("PATCH", { id: clientId }, ownerToken, {
    business_id: "11111111-1111-1111-1111-111111111111",
    user_id: "22222222-2222-2222-2222-222222222222",
  });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("clients: PATCH with a foreign business_id in the body does not move the client", async () => {
  const ownerToken = Deno.env.get("TEST_OWNER_TOKEN") || "";
  const clientId = Deno.env.get("TEST_CLIENT_ID") || "";
  const ownBusinessId = Deno.env.get("TEST_BUSINESS_ID") || "";
  const foreignBusinessId = Deno.env.get("TEST_FOREIGN_BUSINESS_ID") || "";
  if (!ownerToken || !clientId || !ownBusinessId || !foreignBusinessId) return;

  const res = await call("PATCH", { id: clientId }, ownerToken, {
    business_id: foreignBusinessId,
    notes: "S57 regression test",
  });
  assertEquals(res.status, 200);
  const updated = await res.json();
  assertEquals(updated.business_id, ownBusinessId);
  assertNotEquals(updated.business_id, foreignBusinessId);
  assertEquals(updated.notes, "S57 regression test");
});

Deno.test("clients: PATCH targeting a client in a different business → 404, not silently applied", async () => {
  const ownerToken = Deno.env.get("TEST_OWNER_TOKEN") || "";
  const foreignClientId = Deno.env.get("TEST_FOREIGN_CLIENT_ID") || "";
  if (!ownerToken || !foreignClientId) return;

  const res = await call("PATCH", { id: foreignClientId }, ownerToken, { notes: "should not land" });
  assertEquals(res.status, 404);
  await res.body?.cancel();
});
