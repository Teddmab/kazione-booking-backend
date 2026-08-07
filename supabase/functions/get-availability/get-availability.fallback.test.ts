import { assertEquals } from "std/assert";
import { buildFallbackAvailability } from "./index.ts";

Deno.test("buildFallbackAvailability generates slots from working hours", () => {
  const result = buildFallbackAvailability({
    dateStr: "2030-06-15",
    requestedDate: new Date("2030-06-15T00:00:00Z"),
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
