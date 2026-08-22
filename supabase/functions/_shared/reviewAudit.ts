import { supabaseAdmin } from "./supabaseAdmin.ts";

/** All valid tenant-level review-moderation action strings. */
export type ReviewAuditAction = "HIDDEN" | "UNHIDDEN";

export interface ReviewAuditEntry {
  businessId: string;
  reviewId: string;
  actorUserId: string;
  action: ReviewAuditAction;
  reason: string;
  targetMeta?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Appends a row to review_moderation_log — the tenant-scoped equivalent of
 * admin_audit_log, for owner/manager hide/unhide actions on reviews.
 *
 * Fire-and-forget — failures are logged to console but never surface to the
 * caller. An audit-log failure must never block the actual operation.
 */
export async function logReviewModeration(entry: ReviewAuditEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("review_moderation_log").insert({
      business_id: entry.businessId,
      review_id: entry.reviewId,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      reason: entry.reason,
      target_meta: entry.targetMeta ?? null,
      ip_address: entry.ipAddress ?? null,
    });

    if (error) {
      console.error("[reviewAudit] Insert failed:", error.message);
    }
  } catch (err) {
    console.error("[reviewAudit] Unexpected error:", err);
  }
}
