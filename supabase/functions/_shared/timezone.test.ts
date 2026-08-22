// supabase/functions/_shared/timezone.test.ts
//
// Pure unit tests — no live Supabase stack required.
import { assertEquals } from "std/assert";
import {
  isValidIanaTimeZone,
  localDateRangeToUtcIso,
  localWallClockToUtcIso,
  utcIsoToLocalParts,
} from "./timezone.ts";

Deno.test("localWallClockToUtcIso: UTC+3, no DST (Africa/Kampala)", () => {
  // 09:00 Kampala local = 06:00 UTC (UTC+3 year-round, no DST).
  const iso = localWallClockToUtcIso("2026-10-05", "09:00", "Africa/Kampala");
  assertEquals(iso, "2026-10-05T06:00:00.000Z");
});

Deno.test("localWallClockToUtcIso: Europe/Tallinn winter (EET, UTC+2)", () => {
  // January is standard time in Tallinn: UTC+2.
  const iso = localWallClockToUtcIso("2026-01-15", "10:00", "Europe/Tallinn");
  assertEquals(iso, "2026-01-15T08:00:00.000Z");
});

Deno.test("localWallClockToUtcIso: Europe/Tallinn summer (EEST, UTC+3, DST-aware)", () => {
  // July is daylight saving time in Tallinn: UTC+3 — proves the conversion
  // is genuinely DST-aware, not a fixed offset.
  const iso = localWallClockToUtcIso("2026-07-15", "10:00", "Europe/Tallinn");
  assertEquals(iso, "2026-07-15T07:00:00.000Z");
});

Deno.test("localWallClockToUtcIso: UTC passthrough", () => {
  const iso = localWallClockToUtcIso("2026-03-01", "12:30", "UTC");
  assertEquals(iso, "2026-03-01T12:30:00.000Z");
});

Deno.test("utcIsoToLocalParts: inverse of localWallClockToUtcIso round-trips", () => {
  const iso = localWallClockToUtcIso("2026-10-05", "09:00", "Africa/Kampala");
  const parts = utcIsoToLocalParts(iso, "Africa/Kampala");
  assertEquals(parts.date, "2026-10-05");
  assertEquals(parts.time, "09:00");
});

Deno.test("utcIsoToLocalParts: dayOfWeek matches JS getUTCDay() convention (0=Sun..6=Sat)", () => {
  // 2026-10-05 is a Monday.
  const parts = utcIsoToLocalParts("2026-10-05T06:00:00.000Z", "Africa/Kampala");
  assertEquals(parts.dayOfWeek, 1);
});

Deno.test("localDateRangeToUtcIso: 24h window in business-local time", () => {
  // Kampala local midnight is 21:00 UTC the previous day (UTC+3).
  const { startUtcIso, endUtcIsoExclusive } = localDateRangeToUtcIso(
    "2026-10-05",
    "Africa/Kampala",
  );
  assertEquals(startUtcIso, "2026-10-04T21:00:00.000Z");
  assertEquals(endUtcIsoExclusive, "2026-10-05T21:00:00.000Z");
});

Deno.test("isValidIanaTimeZone: accepts real IANA zones", () => {
  assertEquals(isValidIanaTimeZone("Europe/Tallinn"), true);
  assertEquals(isValidIanaTimeZone("Africa/Kampala"), true);
  assertEquals(isValidIanaTimeZone("UTC"), true);
});

Deno.test("isValidIanaTimeZone: rejects garbage", () => {
  assertEquals(isValidIanaTimeZone("Not/A_Zone"), false);
  assertEquals(isValidIanaTimeZone(""), false);
});
