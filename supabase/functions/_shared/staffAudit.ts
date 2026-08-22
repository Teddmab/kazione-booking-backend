import { supabaseAdmin } from "./supabaseAdmin.ts";

/** All valid tenant-level staff-audit action strings. */
export type StaffAuditAction = "STAFF_MAGIC_LINK_ISSUED";

export interface StaffAuditEntry {
  businessId: string;
  actorUserId: string;
  action: StaffAuditAction;
  staffProfileId?: string;
  targetMeta?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Appends a row to staff_action_log — the tenant-scoped equivalent of
 * admin_audit_log, for sensitive owner/manager actions on staff accounts.
 *
 * Fire-and-forget — failures are logged to console but never surface to the
 * caller. An audit-log failure must never block the actual operation.
 */
export async function logStaffAction(entry: StaffAuditEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("staff_action_log").insert({
      business_id: entry.businessId,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      staff_profile_id: entry.staffProfileId ?? null,
      target_meta: entry.targetMeta ?? null,
      ip_address: entry.ipAddress ?? null,
    });

    if (error) {
      console.error("[staffAudit] Insert failed:", error.message);
    }
  } catch (err) {
    console.error("[staffAudit] Unexpected error:", err);
  }
}
