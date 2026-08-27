import { supabaseAdmin } from "./supabaseAdmin.ts";

/** All valid service_activity_log.event_type strings. */
export type ServiceActivityEvent =
  | "service_created"
  | "service_updated"
  | "visibility_changed"
  | "archived"
  | "restored"
  | "offer_sent"
  | "offer_accepted"
  | "offer_declined"
  | "offer_withdrawn"
  | "product_usage_added"
  | "product_usage_removed"
  | "product_usage_updated";

export interface ServiceActivityEntry {
  businessId: string;
  serviceId: string;
  actorUserId?: string | null;
  eventType: ServiceActivityEvent;
  payload?: Record<string, unknown>;
}

/**
 * Appends a row to service_activity_log — backs the owner Services detail
 * modal's Activity tab with real events instead of a fabricated audit trail.
 *
 * Fire-and-forget — failures are logged to console but never surface to the
 * caller. An activity-log failure must never block the actual operation.
 */
export async function logServiceActivity(entry: ServiceActivityEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("service_activity_log").insert({
      business_id: entry.businessId,
      service_id: entry.serviceId,
      actor_user_id: entry.actorUserId ?? null,
      event_type: entry.eventType,
      payload: entry.payload ?? {},
    });

    if (error) {
      console.error("[serviceActivity] Insert failed:", error.message);
    }
  } catch (err) {
    console.error("[serviceActivity] Unexpected error:", err);
  }
}
