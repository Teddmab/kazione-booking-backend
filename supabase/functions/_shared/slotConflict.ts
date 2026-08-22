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
