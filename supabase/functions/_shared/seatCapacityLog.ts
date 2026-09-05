import { supabaseAdmin } from "./supabaseAdmin.ts";

interface SeatCapacityExceededDetail {
  business_id: string;
  appointment_id: string | null;
  starts_at: string;
  ends_at: string;
  configured_capacity: number;
  overlapping_count: number;
  source: string | null;
}

/**
 * check_and_reserve_slot (137_seat_capacity_enforcement.sql) raises
 * SEAT_CAPACITY_EXCEEDED instead of inserting the 'rejected' row into
 * appointment_capacity_shadow_log itself — a RAISE aborts the whole
 * transaction, which would roll back that insert along with everything
 * else. The structured detail needed to log the rejection travels on the
 * exception itself (Postgres DETAIL, surfaced by PostgREST as err.details)
 * and is written here, from the edge function, after the RPC call has
 * already returned and that transaction has already aborted.
 *
 * Call this only after isSeatCapacityExceededError(err) is true. Best-effort:
 * a failure to log must never prevent the caller from returning its 409 to
 * the client — the booking rejection itself already happened in the DB.
 */
export async function logSeatCapacityRejection(err: unknown): Promise<void> {
  const details = (err as { details?: string } | null | undefined)?.details;
  if (!details) return;

  let parsed: SeatCapacityExceededDetail;
  try {
    parsed = JSON.parse(details);
  } catch {
    console.error("Failed to parse SEAT_CAPACITY_EXCEEDED detail:", details);
    return;
  }

  const { error } = await supabaseAdmin.from("appointment_capacity_shadow_log").insert({
    business_id: parsed.business_id,
    appointment_id: parsed.appointment_id,
    starts_at: parsed.starts_at,
    ends_at: parsed.ends_at,
    configured_capacity: parsed.configured_capacity,
    overlapping_count: parsed.overlapping_count,
    would_exceed: true,
    source: parsed.source,
    outcome: "rejected",
  });
  if (error) {
    console.error("Failed to log seat-capacity rejection:", JSON.stringify(error));
  }
}
