// _shared/adminAuth.test.ts
// Unit tests for adminAuth helpers — pure-logic only, no DB required.
import { assertEquals, assertExists } from "std/assert";
import { getCallerIp } from "./adminAuth.ts";

// ── getCallerIp ───────────────────────────────────────────────────────────────

Deno.test("getCallerIp: returns CF-Connecting-IP when present", () => {
  const req = new Request("http://localhost/test", {
    headers: { "CF-Connecting-IP": "1.2.3.4" },
  });
  assertEquals(getCallerIp(req), "1.2.3.4");
});

Deno.test("getCallerIp: falls back to X-Forwarded-For first value", () => {
  const req = new Request("http://localhost/test", {
    headers: { "X-Forwarded-For": "10.0.0.1, 10.0.0.2" },
  });
  assertEquals(getCallerIp(req), "10.0.0.1");
});

Deno.test("getCallerIp: prefers CF-Connecting-IP over X-Forwarded-For", () => {
  const req = new Request("http://localhost/test", {
    headers: {
      "CF-Connecting-IP": "5.5.5.5",
      "X-Forwarded-For": "10.0.0.1",
    },
  });
  assertEquals(getCallerIp(req), "5.5.5.5");
});

Deno.test("getCallerIp: returns undefined when no IP headers present", () => {
  const req = new Request("http://localhost/test");
  assertEquals(getCallerIp(req), undefined);
});

// ── requirePlatformAdmin response shapes (no-auth fast-paths) ─────────────────
// These test the guard logic for missing/invalid Authorization headers without
// hitting the DB — the DB checks are covered by integration tests in ADMIN-02.

Deno.test("requirePlatformAdmin: missing Authorization → 401 response shape", async () => {
  const { requirePlatformAdmin } = await import("./adminAuth.ts");
  const req = new Request("http://localhost/admin-stats");
  const result = await requirePlatformAdmin(req);

  assertExists(result);
  // Must be a Response (not an AdminContext)
  assertEquals(result instanceof Response, true);
  if (result instanceof Response) {
    assertEquals(result.status, 401);
    const body = await result.json();
    assertEquals(body.error.code, "UNAUTHORIZED");
    assertExists(body.error.message);
  }
});

Deno.test("requirePlatformAdmin: Basic auth (non-Bearer) → 401", async () => {
  const { requirePlatformAdmin } = await import("./adminAuth.ts");
  const req = new Request("http://localhost/admin-stats", {
    headers: { Authorization: "Basic dXNlcjpwYXNz" },
  });
  const result = await requirePlatformAdmin(req);

  assertEquals(result instanceof Response, true);
  if (result instanceof Response) {
    assertEquals(result.status, 401);
  }
});

Deno.test("requirePlatformAdmin: empty Bearer token → 401", async () => {
  const { requirePlatformAdmin } = await import("./adminAuth.ts");
  const req = new Request("http://localhost/admin-stats", {
    headers: { Authorization: "Bearer " },
  });
  // A blank token will fail JWT verification → 401
  const result = await requirePlatformAdmin(req);
  assertEquals(result instanceof Response, true);
  if (result instanceof Response) {
    assertEquals(result.status, 401);
  }
});
