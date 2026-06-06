import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson } from "../_shared/adminCors.ts";
import { serverError } from "../_shared/errors.ts";
import { requirePlatformAdmin } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { getCallerIp } from "../_shared/adminAuth.ts";
import { withLogging } from "../_shared/logger.ts";

Deno.serve(withLogging("admin-stats", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  try {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [
      { count: totalBusinesses },
      { count: activeBusinesses },
      { count: totalUsers },
      { count: apptThisMonth },
      { data: revenueData },
      { data: apptByStatus },
    ] = await Promise.all([
      supabaseAdmin.from("businesses").select("*", { count: "exact", head: true }),
      supabaseAdmin.from("businesses").select("*", { count: "exact", head: true }).eq("is_active", true),
      supabaseAdmin.from("users").select("*", { count: "exact", head: true }),
      supabaseAdmin.from("appointments").select("*", { count: "exact", head: true }).gte("starts_at", monthStart),
      supabaseAdmin.from("payments").select("amount").eq("status", "paid").gte("paid_at", monthStart),
      supabaseAdmin.from("appointments").select("status").gte("starts_at", monthStart),
    ]);

    const revenueThisMonth = (revenueData ?? []).reduce(
      (sum: number, r: { amount: string }) => sum + parseFloat(r.amount),
      0,
    );

    const statusCounts: Record<string, number> = {};
    for (const row of (apptByStatus ?? [])) {
      const s = (row as { status: string }).status;
      statusCounts[s] = (statusCounts[s] ?? 0) + 1;
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "STATS_VIEWED",
      ipAddress: getCallerIp(req),
    });

    return adminJson({
      total_businesses: totalBusinesses ?? 0,
      active_businesses: activeBusinesses ?? 0,
      total_users: totalUsers ?? 0,
      appointments_this_month: apptThisMonth ?? 0,
      revenue_this_month: revenueThisMonth,
      appointments_by_status: statusCounts,
    });
  } catch (err) {
    console.error("[admin-stats]", err);
    return serverError();
  }
}));
