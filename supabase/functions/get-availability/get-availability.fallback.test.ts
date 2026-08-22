import { assertEquals } from "std/assert";
import { buildFallbackAvailability } from "./index.ts";

Deno.test("buildFallbackAvailability generates slots from working hours", () => {
  const result = buildFallbackAvailability({
    dateStr: "2030-06-15",
    requestedDate: new Date("2030-06-15T00:00:00Z"),
    businessTimezone: "UTC",
    durationMinutes: 60,
    slotIntervalMinutes: 30,
    leadHours: 2,
    serviceInfo: {
      id: "svc-1",
      name: "Haircut",
      durationMinutes: 60,
      price: 50,
    },
    staffRows: [
      {
        id: "staff-1",
        display_name: "Ana",
        custom_price: 60,
      },
    ],
    workingHoursRows: [
      {
        staff_profile_id: "staff-1",
        start_time: "09:00",
        end_time: "11:00",
        is_working: true,
      },
    ],
    appointmentRows: [],
    timeOffRows: [],
    hideStaffNames: false,
    requestedStaffId: null,
  });

  assertEquals(result.slots.length, 3);
  assertEquals(result.slots[0].time, "09:00");
  assertEquals(result.slots[0].staff[0].id, "staff-1");
  assertEquals(result.isAvailable, true);
});

Deno.test("buildFallbackAvailability: slot label is business-local, not UTC (S59)", () => {
  // Africa/Kampala is UTC+3, no DST. "09:00" working hours must produce a
  // slot labeled "09:00" whose underlying instant is 06:00 UTC — proving
  // the fallback path (like the RPC) treats working hours as local
  // wall-clock, not a hardcoded UTC offset.
  const result = buildFallbackAvailability({
    dateStr: "2030-06-15",
    requestedDate: new Date("2030-06-15T00:00:00Z"),
    businessTimezone: "Africa/Kampala",
    durationMinutes: 60,
    slotIntervalMinutes: 30,
    leadHours: 2,
    serviceInfo: { id: "svc-1", name: "Haircut", durationMinutes: 60, price: 50 },
    staffRows: [{ id: "staff-1", display_name: "Ana", custom_price: 60 }],
    workingHoursRows: [
      { staff_profile_id: "staff-1", start_time: "09:00", end_time: "11:00", is_working: true },
    ],
    appointmentRows: [],
    timeOffRows: [],
    hideStaffNames: false,
    requestedStaffId: null,
  });

  assertEquals(result.slots[0].time, "09:00");

  // A conflicting appointment at 06:00 UTC (= 09:00 Kampala local) must
  // block the "09:00" slot — proving the instant used for overlap-checking
  // is the correct converted one, not a naive UTC-literal construction.
  const blocked = buildFallbackAvailability({
    dateStr: "2030-06-15",
    requestedDate: new Date("2030-06-15T00:00:00Z"),
    businessTimezone: "Africa/Kampala",
    durationMinutes: 60,
    slotIntervalMinutes: 30,
    leadHours: 2,
    serviceInfo: { id: "svc-1", name: "Haircut", durationMinutes: 60, price: 50 },
    staffRows: [{ id: "staff-1", display_name: "Ana", custom_price: 60 }],
    workingHoursRows: [
      { staff_profile_id: "staff-1", start_time: "09:00", end_time: "11:00", is_working: true },
    ],
    appointmentRows: [
      {
        staff_profile_id: "staff-1",
        starts_at: "2030-06-15T06:00:00.000Z",
        ends_at: "2030-06-15T07:00:00.000Z",
        status: "confirmed",
      },
    ],
    timeOffRows: [],
    hideStaffNames: false,
    requestedStaffId: null,
  });

  assertEquals(blocked.slots.some((s) => s.time === "09:00"), false);
});
