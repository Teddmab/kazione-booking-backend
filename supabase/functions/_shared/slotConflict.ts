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

/**
 * Detects the two warn-then-confirm exceptions check_and_reserve_slot raises
 * for the five owner-facing RPCs when p_allow_confirm is true and
 * p_confirm_conflict is false (see migration 139_owner_conflict_warn_confirm.sql).
 * Distinct from isSlotTakenError/isSeatCapacityExceededError, which only ever
 * fire for the public path (p_allow_confirm defaults false there).
 */
export function isStaffConflictConfirmRequiredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const errStr = JSON.stringify(err).toUpperCase();
  return errStr.includes("STAFF_CONFLICT_CONFIRM_REQUIRED");
}

export function isSeatCapacityConfirmRequiredError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const errStr = JSON.stringify(err).toUpperCase();
  return errStr.includes("SEAT_CAPACITY_CONFIRM_REQUIRED");
}

/**
 * Extracts the JSON payload check_and_reserve_slot attaches via Postgres
 * DETAIL to a *_CONFIRM_REQUIRED exception — PostgREST surfaces it as
 * err.details. Returns null if absent or unparseable rather than throwing,
 * since a missing/malformed detail should degrade to a generic warning
 * message, not crash the request.
 */
export function parseConflictConfirmDetail(err: unknown): Record<string, unknown> | null {
  const details = (err as { details?: string } | null | undefined)?.details;
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}

export interface ConflictConfirmation {
  code: "STAFF_CONFLICT_CONFIRM_REQUIRED" | "SEAT_CAPACITY_CONFIRM_REQUIRED";
  message: string;
  details: Record<string, unknown> | null;
}

/**
 * Builds the structured "needs confirmation" payload for one of the five
 * owner-facing RPCs (migration 139) — the caller wraps this in a 409
 * conflict() response. Returns null when err is neither confirm-required
 * exception, so callers can fall through to their other error handling.
 */
export function buildConflictConfirmation(err: unknown): ConflictConfirmation | null {
  if (isStaffConflictConfirmRequiredError(err)) {
    return {
      code: "STAFF_CONFLICT_CONFIRM_REQUIRED",
      message: "This staff member already has a conflicting appointment at this time.",
      details: parseConflictConfirmDetail(err),
    };
  }
  if (isSeatCapacityConfirmRequiredError(err)) {
    const detail = parseConflictConfirmDetail(err);
    const configured = detail?.configured_capacity;
    const overlapping = detail?.overlapping_count;
    const message = typeof configured === "number" && typeof overlapping === "number"
      ? `This would put ${overlapping + 1} appointments in this time slot, over your configured limit of ${configured}.`
      : "This would exceed this business's configured seat capacity.";
    return { code: "SEAT_CAPACITY_CONFIRM_REQUIRED", message, details: detail };
  }
  return null;
}
