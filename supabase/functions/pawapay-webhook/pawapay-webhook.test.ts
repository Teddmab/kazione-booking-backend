// supabase/functions/pawapay-webhook/pawapay-webhook.test.ts
import { assertEquals } from "https://deno.land/std/testing/asserts.ts";

const BASE = "http://127.0.0.1:54321/functions/v1";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

// Local dev webhook secret from .env (used in integration tests only when available)
const WEBHOOK_SECRET = Deno.env.get("PAWAPAY_WEBHOOK_SECRET") ?? "";

// ---------------------------------------------------------------------------
// Helper: compute HMAC-SHA256 hex signature
// ---------------------------------------------------------------------------

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function callWebhook(
  body: Record<string, unknown>,
  signature?: string,
) {
  const rawBody = JSON.stringify(body);
  const sig =
    signature !== undefined
      ? signature
      : WEBHOOK_SECRET
      ? await hmacSha256Hex(WEBHOOK_SECRET, rawBody)
      : "invalidsignature";

  return fetch(`${BASE}/pawapay-webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      "x-pawapay-signature": sig,
    },
    body: rawBody,
  });
}

// ---------------------------------------------------------------------------
// Signature tests
// ---------------------------------------------------------------------------

Deno.test("pawapay-webhook: wrong signature returns 400", async () => {
  if (!WEBHOOK_SECRET) {
    console.log("  [SKIP] PAWAPAY_WEBHOOK_SECRET not set");
    return;
  }
  const res = await callWebhook(
    { depositId: "test-123", status: "COMPLETED" },
    "000000000000000000000000000000000000000000000000000000000000dead",
  );
  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.error.code, "INVALID_SIGNATURE");
});

Deno.test("pawapay-webhook: GET method returns 405", async () => {
  const res = await fetch(`${BASE}/pawapay-webhook`, {
    headers: { apikey: ANON_KEY },
  });
  assertEquals(res.status, 405);
  await res.body?.cancel();
});

Deno.test("pawapay-webhook: missing depositId returns 200 (graceful)", async () => {
  if (!WEBHOOK_SECRET) {
    console.log("  [SKIP] PAWAPAY_WEBHOOK_SECRET not set");
    return;
  }
  const res = await callWebhook({ status: "COMPLETED" });
  // Missing depositId — function still returns 200 (log + skip)
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.received, true);
});

Deno.test("pawapay-webhook: FAILED status with valid signature returns 200", async () => {
  if (!WEBHOOK_SECRET) {
    console.log("  [SKIP] PAWAPAY_WEBHOOK_SECRET not set");
    return;
  }
  const res = await callWebhook({
    depositId: "non-existent-deposit-id",
    status: "FAILED",
    amount: "25.00",
    currency: "UGX",
  });
  // Payment update fails silently (no record found), still 200
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.received, true);
});

Deno.test("pawapay-webhook: COMPLETED status with valid signature returns 200", async () => {
  if (!WEBHOOK_SECRET) {
    console.log("  [SKIP] PAWAPAY_WEBHOOK_SECRET not set");
    return;
  }
  const res = await callWebhook({
    depositId: "non-existent-deposit-id-completed",
    status: "COMPLETED",
    amount: "25.00",
    currency: "UGX",
  });
  // No matching payment record — function logs and returns 200
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.received, true);
});

Deno.test("pawapay-webhook: unhandled status returns 200", async () => {
  if (!WEBHOOK_SECRET) {
    console.log("  [SKIP] PAWAPAY_WEBHOOK_SECRET not set");
    return;
  }
  const res = await callWebhook({
    depositId: "test-deposit-id",
    status: "ENQUEUED",
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
});
