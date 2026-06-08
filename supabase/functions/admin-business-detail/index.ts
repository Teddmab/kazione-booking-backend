import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson } from "../_shared/adminCors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { requirePlatformAdmin } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { getCallerIp } from "../_shared/adminAuth.ts";
import { withLogging } from "../_shared/logger.ts";

Deno.serve(withLogging("admin-business-detail", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return badRequest("id is required");

  try {
    const { data: business, error: bizError } = await supabaseAdmin
      .from("businesses")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (bizError) {
      console.error("[admin-business-detail] business error:", bizError.message);
      return serverError();
    }
    if (!business) return notFound("Business not found");

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [
      { count: memberCount },
      { count: totalAppts },
      { count: apptThisMonth },
      { data: revenueData },
      { data: recentAppts },
      { data: paymentSettings },
      { data: members },
    ] = await Promise.all([
      supabaseAdmin.from("business_members").select("*", { count: "exact", head: true }).eq("business_id", id).eq("is_active", true),
      supabaseAdmin.from("appointments").select("*", { count: "exact", head: true }).eq("business_id", id),
      supabaseAdmin.from("appointments").select("*", { count: "exact", head: true }).eq("business_id", id).gte("starts_at", monthStart),
      supabaseAdmin.from("payments").select("amount").eq("business_id", id).eq("status", "paid"),
      supabaseAdmin.from("appointments")
        .select("id, booking_reference, status, starts_at, price, client:clients(first_name, last_name), service:services(name)")
        .eq("business_id", id)
        .order("starts_at", { ascending: false })
        .limit(10),
      supabaseAdmin.from("business_settings")
        .select("stripe_enabled, pawapay_enabled, accept_cash, payment_required_online, stripe_account_id")
        .eq("business_id", id)
        .maybeSingle(),
      supabaseAdmin.from("business_members")
        .select("id, role, created_at, user:users(id, email, first_name, last_name, is_platform_admin)")
        .eq("business_id", id)
        .eq("is_active", true)
        .order("created_at", { ascending: true }),
    ]);

    const totalRevenue = (revenueData ?? []).reduce(
      (sum: number, r: { amount: string }) => sum + parseFloat(r.amount),
      0,
    );

    logAdminAction({
      adminId: ctx.adminId,
      action: "BUSINESS_VIEWED",
      targetType: "business",
      targetId: id,
      targetMeta: { name: business.name },
      ipAddress: getCallerIp(req),
    });

    return adminJson({
      business,
      members: members ?? [],
      stats: {
        member_count: memberCount ?? 0,
        total_appointments: totalAppts ?? 0,
        appointments_this_month: apptThisMonth ?? 0,
        total_revenue: totalRevenue,
      },
      payment_settings: paymentSettings ?? {
        stripe_enabled: true,
        pawapay_enabled: false,
        accept_cash: true,
        payment_required_online: false,
        stripe_account_id: null,
      },
      recent_appointments: recentAppts ?? [],
    });
  } catch (err) {
    console.error("[admin-business-detail]", err);
    return serverError();
  }
}));
