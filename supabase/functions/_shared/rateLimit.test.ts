// supabase/functions/_shared/rateLimit.test.ts
//
// Pure unit tests — no live Supabase stack required. Confirms the
// checkRateLimit wiring get-booking (S57) now relies on actually blocks
// once a public-looking caller exceeds the configured budget.
//
// checkRateLimit deliberately no-ops for loopback/private/CI-flagged
// requests (see rateLimit.ts) — that's why these tests use a synthetic
// public IP via x-forwarded-for rather than hitting the real local stack,
// where every request arrives from 127.0.0.1 and would never trip the limit.
import { assertEquals } from "std/assert";
import { checkRateLimit } from "./rateLimit.ts";

function requestFrom(ip: string, path = "/get-booking") {
  return new Request(`http://localhost${path}`, {
    headers: { "x-forwarded-for": ip },
  });
}

Deno.test("checkRateLimit: allows requests under the limit", () => {
  const ip = "203.0.113.10";
  for (let i = 0; i < 3; i++) {
    const res = checkRateLimit(requestFrom(ip), 5, 60_000);
    assertEquals(res, null);
  }
});

Deno.test("checkRateLimit: blocks once the limit is exceeded, within the same window", () => {
  const ip = "203.0.113.11";
  for (let i = 0; i < 5; i++) {
    const res = checkRateLimit(requestFrom(ip), 5, 60_000);
    assertEquals(res, null);
  }
  const blocked = checkRateLimit(requestFrom(ip), 5, 60_000);
  assertEquals(blocked?.status, 429);
});

Deno.test("checkRateLimit: is keyed independently per path+IP", () => {
  const ip = "203.0.113.12";
  for (let i = 0; i < 5; i++) {
    checkRateLimit(requestFrom(ip, "/get-booking"), 5, 60_000);
  }
  // Same IP, different path — separate window, not yet exhausted.
  const res = checkRateLimit(requestFrom(ip, "/lookup-booking"), 5, 60_000);
  assertEquals(res, null);
});

Deno.test("checkRateLimit: skips loopback IPs (matches local-dev/CI behavior)", () => {
  const res = checkRateLimit(requestFrom("127.0.0.1"), 1, 60_000);
  assertEquals(res, null);
  // A second call with the same tiny budget would still be null — loopback
  // is exempt entirely, not just under a high limit.
  const res2 = checkRateLimit(requestFrom("127.0.0.1"), 1, 60_000);
  assertEquals(res2, null);
});
