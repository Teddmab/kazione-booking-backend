import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson, adminErrors } from "../_shared/adminCors.ts";
import { serverError, badRequest } from "../_shared/errors.ts";
import { requirePlatformAdmin } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { getCallerIp } from "../_shared/adminAuth.ts";
import { withLogging } from "../_shared/logger.ts";

Deno.serve(withLogging("admin-users", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);

  // ── PATCH — toggle is_platform_admin ──────────────────────────────────────
  if (req.method === "PATCH") {
    try {
      const body = await req.json();
      const { user_id, is_platform_admin } = body as { user_id?: string; is_platform_admin?: boolean };

      if (!user_id || typeof is_platform_admin !== "boolean") {
        return badRequest("user_id and is_platform_admin are required");
      }
      if (user_id === ctx.adminId) {
        return adminErrors.forbidden("Cannot change your own admin status");
      }

      const { error } = await supabaseAdmin
        .from("users")
        .update({ is_platform_admin })
        .eq("id", user_id);

      if (error) {
        console.error("[admin-users] patch error:", error.message);
        return serverError();
      }

      logAdminAction({
        adminId: ctx.adminId,
        action: is_platform_admin ? "USER_PROMOTED_ADMIN" : "USER_DEMOTED_ADMIN",
        targetType: "user",
        targetId: user_id,
        ipAddress: getCallerIp(req),
      });

      return adminJson({ success: true });
    } catch (err) {
      console.error("[admin-users] patch", err);
      return serverError();
    }
  }

  // ── GET ?user_id= — single user 360 view ─────────────────────────────────
  const userId = url.searchParams.get("user_id");
  if (userId) {
    try {
      const { data: user, error } = await supabaseAdmin
        .from("users")
        .select(
          `id, email, first_name, last_name, avatar_url, is_platform_admin, created_at,
           business_members(
             id, role, created_at,
             business:businesses(id, name, slug, industry, is_active, country)
           )`,
        )
        .eq("id", userId)
        .maybeSingle();

      if (error) {
        console.error("[admin-users] detail error:", error.message);
        return serverError();
      }
      if (!user) return adminErrors.unauthorized("User not found");

      // Recent client appointments (if this user also has a client record)
      const { data: clientRow } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle();

      const recentAppointments = clientRow
        ? (await supabaseAdmin
            .from("appointments")
            .select(
              `id, booking_reference, status, starts_at, price,
               business:businesses(id, name),
               service:services(id, name)`,
            )
            .eq("client_id", clientRow.id)
            .order("starts_at", { ascending: false })
            .limit(10)
          ).data ?? []
        : [];

      logAdminAction({
        adminId: ctx.adminId,
        action: "USER_VIEWED",
        targetType: "user",
        targetId: userId,
        ipAddress: getCallerIp(req),
      });

      return adminJson({ user, recent_appointments: recentAppointments });
    } catch (err) {
      console.error("[admin-users] detail", err);
      return serverError();
    }
  }

  // ── GET — paginated list ───────────────────────────────────────────────────
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "25", 10)));
  const offset = (page - 1) * limit;
  const search = url.searchParams.get("search") ?? "";

  try {
    let query = supabaseAdmin
      .from("users")
      .select(
        `id, email, first_name, last_name, avatar_url, is_platform_admin, created_at,
         business_members(role, business:businesses(id, name, slug))`,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`email.ilike.%${search}%,first_name.ilike.%${search}%,last_name.ilike.%${search}%`);
    }

    const { data, count, error } = await query;
    if (error) {
      console.error("[admin-users] error:", error.message);
      return serverError();
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "USERS_LISTED",
      ipAddress: getCallerIp(req),
    });

    return adminJson({ data: data ?? [], total: count ?? 0, page, limit });
  } catch (err) {
    console.error("[admin-users]", err);
    return serverError();
  }
}));
