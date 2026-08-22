import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson, adminErrors } from "../_shared/adminCors.ts";
import { requirePlatformAdmin } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { getCallerIp } from "../_shared/adminAuth.ts";
import { withLogging } from "../_shared/logger.ts";

Deno.serve(withLogging("admin-audit-log", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get("limit") ?? "25", 10)));
  const offset = (page - 1) * limit;
  const action = url.searchParams.get("action");

  try {
    let query = supabaseAdmin
      .from("admin_audit_log")
      .select(
        `id, action, target_type, target_id, target_meta, ip_address, created_at,
         admin:users!admin_audit_log_admin_id_fkey(id, email, first_name, last_name)`,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (action) query = query.eq("action", action);

    const { data, count, error } = await query;
    if (error) {
      console.error("[admin-audit-log] error:", error.message);
      // Safe to surface the real DB error here — this endpoint is already
      // gated behind requirePlatformAdmin, so only trusted platform admins
      // ever see this response, and it's what platform-alert-digest reads
      // to show real detail instead of a generic "Internal server error".
      return adminErrors.serverError(error.message);
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "AUDIT_LOG_VIEWED",
      ipAddress: getCallerIp(req),
    });

    return adminJson({
      data: data ?? [],
      total: count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    console.error("[admin-audit-log]", err);
    return adminErrors.serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
