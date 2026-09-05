/**
 * Detects the SLOT_TAKEN exception raised by check_and_reserve_slot and its
 * callers (create_booking_atomic, create_manual_appointment_atomic,
 * assign_staff_atomic, assign_staff_2_atomic, reschedule_appointment_atomic
 * — see migration 112_check_and_reserve_slot.sql). Matches all error fields
 * because the exact shape varies between Supabase client / PostgREST
 * versions (message, code, details, hint may all carry the text) — mirrors
 * the inline check already used in create-booking/index.ts.
 */
export function isSlotTakenError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  const errStr = JSON.stringify(err).toUpperCase();
  return code === "P0001" || errStr.includes("SLOT_TAKEN");
}

/**
 * Detects the SEAT_CAPACITY_EXCEEDED exception raised by check_and_reserve_slot
 * for pilot-enforced businesses (see migration 137_seat_capacity_enforcement.sql).
 * Same error-shape caveat as isSlotTakenError above — this is a distinct
 * PostgreSQL exception from SLOT_TAKEN (both surface as code P0001), so check
 * this FIRST when both are relevant, since the public-facing message must never
 * mention seats/capacity even though the internal error code does.
 */
export function isSeatCapacityExceededError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const errStr = JSON.stringify(err).toUpperCase();
  return errStr.includes("SEAT_CAPACITY_EXCEEDED");
}
