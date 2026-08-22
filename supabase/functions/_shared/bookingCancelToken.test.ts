// supabase/functions/_shared/bookingCancelToken.test.ts
//
// Pure unit tests — no live Supabase stack required. Covers S57 finding 5:
// the secret must fail closed (throw) rather than fall back to a hardcoded,
// repo-public value when neither env var is configured.
import { assertEquals, assertRejects } from "std/assert";
import { issueCancelToken, verifyCancelToken } from "./bookingCancelToken.ts";

const SECRET_KEYS = ["BOOKING_CANCEL_TOKEN_SECRET", "SUPABASE_JWT_SECRET"];

function clearSecrets() {
  for (const key of SECRET_KEYS) Deno.env.delete(key);
}

async function withSecret<T>(key: string, value: string, fn: () => T | Promise<T>): Promise<T> {
  const prior = Deno.env.get(key);
  Deno.env.set(key, value);
  try {
    return await fn();
  } finally {
    if (prior === undefined) Deno.env.delete(key);
    else Deno.env.set(key, prior);
  }
}

Deno.test("bookingCancelToken: issueCancelToken throws when no secret is configured", async () => {
  const priorValues = SECRET_KEYS.map((k) => Deno.env.get(k));
  clearSecrets();
  try {
    await assertRejects(
      () => issueCancelToken("00000000-0000-0000-0000-000000000000", "KZB-ABCDE"),
      Error,
    );
  } finally {
    SECRET_KEYS.forEach((k, i) => {
      if (priorValues[i] !== undefined) Deno.env.set(k, priorValues[i]!);
    });
  }
});

Deno.test("bookingCancelToken: verifyCancelToken throws when no secret is configured", async () => {
  const priorValues = SECRET_KEYS.map((k) => Deno.env.get(k));
  clearSecrets();
  try {
    await assertRejects(
      () => verifyCancelToken("some.token"),
      Error,
    );
  } finally {
    SECRET_KEYS.forEach((k, i) => {
      if (priorValues[i] !== undefined) Deno.env.set(k, priorValues[i]!);
    });
  }
});

Deno.test("bookingCancelToken: round-trips a valid token when BOOKING_CANCEL_TOKEN_SECRET is set", async () => {
  const priorValues = SECRET_KEYS.map((k) => Deno.env.get(k));
  clearSecrets();
  try {
    await withSecret("BOOKING_CANCEL_TOKEN_SECRET", "test-secret-value", async () => {
      const token = await issueCancelToken("11111111-1111-1111-1111-111111111111", "KZB-12345", 1);
      const payload = await verifyCancelToken(token);
      assertEquals(payload?.aid, "11111111-1111-1111-1111-111111111111");
      assertEquals(payload?.br, "KZB-12345");
    });
  } finally {
    SECRET_KEYS.forEach((k, i) => {
      if (priorValues[i] !== undefined) Deno.env.set(k, priorValues[i]!);
    });
  }
});

Deno.test("bookingCancelToken: rejects a token signed with a different secret", async () => {
  const priorValues = SECRET_KEYS.map((k) => Deno.env.get(k));
  clearSecrets();
  try {
    const token = await withSecret(
      "BOOKING_CANCEL_TOKEN_SECRET",
      "secret-a",
      () => issueCancelToken("22222222-2222-2222-2222-222222222222", "KZB-99999", 1),
    );

    const payload = await withSecret(
      "BOOKING_CANCEL_TOKEN_SECRET",
      "secret-b",
      () => verifyCancelToken(token),
    );
    assertEquals(payload, null);
  } finally {
    SECRET_KEYS.forEach((k, i) => {
      if (priorValues[i] !== undefined) Deno.env.set(k, priorValues[i]!);
    });
  }
});

Deno.test("bookingCancelToken: rejects an expired token", async () => {
  const priorValues = SECRET_KEYS.map((k) => Deno.env.get(k));
  clearSecrets();
  try {
    await withSecret("BOOKING_CANCEL_TOKEN_SECRET", "test-secret-value", async () => {
      const token = await issueCancelToken(
        "33333333-3333-3333-3333-333333333333",
        "KZB-00001",
        -1, // already expired
      );
      const payload = await verifyCancelToken(token);
      assertEquals(payload, null);
    });
  } finally {
    SECRET_KEYS.forEach((k, i) => {
      if (priorValues[i] !== undefined) Deno.env.set(k, priorValues[i]!);
    });
  }
});
