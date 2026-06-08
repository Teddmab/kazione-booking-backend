import { supabaseAdmin } from "./supabaseAdmin.ts";

/** All valid platform admin action strings. */
export type AdminAction =
  | "STATS_VIEWED"
  | "BUSINESSES_LISTED"
  | "BUSINESS_VIEWED"
  | "BUSINESS_DISABLED"
  | "BUSINESS_ENABLED"
  | "BUSINESS_PAYMENT_SETTINGS_UPDATED"
  | "APPOINTMENTS_LISTED"
  | "APPOINTMENT_VIEWED"
  | "USERS_LISTED"
  | "USER_VIEWED"
  | "USER_PROMOTED_ADMIN"
  | "USER_DEMOTED_ADMIN"
  | "PAYMENTS_LISTED"
  | "AUDIT_LOG_VIEWED"
  | "REGION_ENABLED"
  | "REGION_DISABLED";

export interface AuditEntry {
  adminId: string;
  action: AdminAction;
  targetType?: "business" | "user" | "appointment" | "payment";
  targetId?: string;
  targetMeta?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Appends a row to admin_audit_log.
 *
 * Fire-and-forget — failures are logged to console but never surface to the
 * caller. An audit-log failure must never block the actual admin operation.
 */
export async function logAdminAction(entry: AuditEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("admin_audit_log").insert({
      admin_id: entry.adminId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      target_meta: entry.targetMeta ?? null,
      ip_address: entry.ipAddress ?? null,
    });

    if (error) {
      console.error("[adminAudit] Insert failed:", error.message);
    }
  } catch (err) {
    console.error("[adminAudit] Unexpected error:", err);
  }
}
