import { assertEquals } from "std/assert";
import { isExpoPushToken } from "./expoPushToken.ts";

Deno.test("isExpoPushToken accepts ExponentPushToken", () => {
  assertEquals(isExpoPushToken("ExponentPushToken[abc123]"), true);
});

Deno.test("isExpoPushToken accepts ExpoPushToken", () => {
  assertEquals(isExpoPushToken("ExpoPushToken[xyz]"), true);
});

Deno.test("isExpoPushToken rejects garbage", () => {
  assertEquals(isExpoPushToken("not-a-token"), false);
  assertEquals(isExpoPushToken(""), false);
  assertEquals(isExpoPushToken("ExponentPushToken[]"), false);
});
