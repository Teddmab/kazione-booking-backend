import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson, adminErrors } from "../_shared/adminCors.ts";
import { serverError } from "../_shared/errors.ts";
import { requirePlatformAdmin } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { getCallerIp } from "../_shared/adminAuth.ts";
import { withLogging } from "../_shared/logger.ts";

Deno.serve(withLogging("admin-appointments", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);

  // ── GET ?appointment_id= — single appointment 360 view ───────────────────
  const appointmentId = url.searchParams.get("appointment_id");
  if (appointmentId) {
    try {
      const { data, error } = await supabaseAdmin
        .from("appointments")
        .select(
          `id, booking_reference, status, starts_at, ends_at, price, notes, is_walk_in, created_at,
           business:businesses(id, name, slug, country, currency_code),
           client:clients(id, first_name, last_name, email, phone),
           service:services(id, name, duration_minutes, price),
           staff:staff_profiles(id, display_name),
           payments(id, amount, tip_amount, currency_code, status, method, paid_at, created_at)`,
        )
        .eq("id", appointmentId)
        .maybeSingle();

      if (error) {
        console.error("[admin-appointments] detail error:", error.message);
        return serverError();
      }
      if (!data) return adminErrors.unauthorized("Appointment not found");

      logAdminAction({
        adminId: ctx.adminId,
        action: "APPOINTMENT_VIEWED",
        targetType: "appointment",
        targetId: appointmentId,
        ipAddress: getCallerIp(req),
      });

      return adminJson(data);
    } catch (err) {
      console.error("[admin-appointments] detail", err);
      return serverError();
    }
  }

  // ── GET — paginated list ───────────────────────────────────────────────────
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "25", 10)));
  const offset = (page - 1) * limit;
  const businessId = url.searchParams.get("business_id");
  const status = url.searchParams.get("status");
  const dateFrom = url.searchParams.get("date_from");
  const dateTo = url.searchParams.get("date_to");

  try {
    let query = supabaseAdmin
      .from("appointments")
      .select(
        `id, booking_reference, status, starts_at, ends_at, price, is_walk_in, created_at,
         business:businesses(id, name, slug),
         client:clients(id, first_name, last_name, email),
         service:services(id, name),
         staff:staff_profiles(id, display_name)`,
        { count: "exact" },
      )
      .order("starts_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (businessId) query = query.eq("business_id", businessId);
    if (status) query = query.eq("status", status);
    if (dateFrom) query = query.gte("starts_at", dateFrom);
    if (dateTo) query = query.lte("starts_at", dateTo);

    const { data, count, error } = await query;
    if (error) {
      console.error("[admin-appointments] error:", error.message);
      return serverError();
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "APPOINTMENTS_LISTED",
      ipAddress: getCallerIp(req),
    });

    return adminJson({ data: data ?? [], total: count ?? 0, page, limit });
  } catch (err) {
    console.error("[admin-appointments]", err);
    return serverError();
  }
}));
