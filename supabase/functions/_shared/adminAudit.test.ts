// _shared/adminAudit.test.ts
// Unit tests for adminAudit helpers — type and shape validation.
import { assertEquals, assertExists } from "std/assert";
import type { AdminAction, AuditEntry } from "./adminAudit.ts";

// ── AdminAction type coverage ─────────────────────────────────────────────────

Deno.test("AdminAction: all expected action strings are defined", () => {
  const actions: AdminAction[] = [
    "STATS_VIEWED",
    "BUSINESSES_LISTED",
    "BUSINESS_VIEWED",
    "BUSINESS_DISABLED",
    "BUSINESS_ENABLED",
    "APPOINTMENTS_LISTED",
    "APPOINTMENT_VIEWED",
    "USERS_LISTED",
    "USER_VIEWED",
    "PAYMENTS_LISTED",
    "AUDIT_LOG_VIEWED",
  ];
  assertEquals(actions.length, 11);
  // Verify each is a non-empty string
  for (const a of actions) {
    assertEquals(typeof a, "string");
    assertEquals(a.length > 0, true);
  }
});

// ── AuditEntry shape ──────────────────────────────────────────────────────────

Deno.test("AuditEntry: required fields compile and are correctly typed", () => {
  const entry: AuditEntry = {
    adminId: "00000000-0000-0000-0000-000000000001",
    action: "BUSINESS_DISABLED",
  };
  assertExists(entry.adminId);
  assertEquals(entry.action, "BUSINESS_DISABLED");
  assertEquals(entry.targetType, undefined);
  assertEquals(entry.targetId, undefined);
  assertEquals(entry.targetMeta, undefined);
  assertEquals(entry.ipAddress, undefined);
});

Deno.test("AuditEntry: full entry with all optional fields", () => {
  const entry: AuditEntry = {
    adminId: "00000000-0000-0000-0000-000000000001",
    action: "BUSINESS_DISABLED",
    targetType: "business",
    targetId: "00000000-0000-0000-0000-000000000002",
    targetMeta: { name: "Test Salon", previous_active: true, reason: "policy violation" },
    ipAddress: "1.2.3.4",
  };

  assertEquals(entry.targetType, "business");
  assertEquals(entry.targetId, "00000000-0000-0000-0000-000000000002");
  assertEquals((entry.targetMeta as Record<string, unknown>)["name"], "Test Salon");
  assertEquals(entry.ipAddress, "1.2.3.4");
});

Deno.test("AuditEntry: all valid targetType values compile", () => {
  const types: AuditEntry["targetType"][] = [
    "business",
    "user",
    "appointment",
    "payment",
    undefined,
  ];
  assertEquals(types.length, 5);
});

// ── logAdminAction error resilience ──────────────────────────────────────────
// logAdminAction is fire-and-forget — it must never throw even if the DB
// insert fails. We test this by calling it in an environment where supabaseAdmin
// is not configured (env vars missing). The function must catch and log, not throw.

Deno.test("logAdminAction: does not throw when DB is unavailable", async () => {
  const { logAdminAction } = await import("./adminAudit.ts");
  // This will fail to connect to Supabase (no running stack in unit test env)
  // but must not throw — it's fire-and-forget
  let threw = false;
  try {
    await logAdminAction({
      adminId: "00000000-0000-0000-0000-000000000001",
      action: "STATS_VIEWED",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, false, "logAdminAction must never throw");
});
