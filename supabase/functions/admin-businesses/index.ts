import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson } from "../_shared/adminCors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { requirePlatformAdmin } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { getCallerIp } from "../_shared/adminAuth.ts";
import { withLogging } from "../_shared/logger.ts";

Deno.serve(withLogging("admin-businesses", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);

  // ── PATCH: toggle is_active ────────────────────────────────────────────────
  if (req.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return badRequest("id is required");

    let body: { is_active?: boolean };
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    if (typeof body.is_active !== "boolean") {
      return badRequest("is_active (boolean) is required");
    }

    const { data, error } = await supabaseAdmin
      .from("businesses")
      .update({ is_active: body.is_active, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id, name, is_active")
      .single();

    if (error) {
      console.error("[admin-businesses] update error:", error.message);
      return serverError();
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: body.is_active ? "BUSINESS_ENABLED" : "BUSINESS_DISABLED",
      targetType: "business",
      targetId: id,
      targetMeta: { name: data.name },
      ipAddress: getCallerIp(req),
    });

    return adminJson(data);
  }

  // ── GET: paginated list ────────────────────────────────────────────────────
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "25", 10)));
  const search = url.searchParams.get("search") ?? "";
  const status = url.searchParams.get("status"); // "active" | "inactive"
  const offset = (page - 1) * limit;

  try {
    let query = supabaseAdmin
      .from("businesses")
      .select(
        `id, name, slug, industry, country, currency_code, logo_url, is_active, created_at,
         business_members(count)`,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      query = query.or(`name.ilike.%${search}%,slug.ilike.%${search}%`);
    }
    if (status === "active") query = query.eq("is_active", true);
    if (status === "inactive") query = query.eq("is_active", false);

    const { data, count, error } = await query;
    if (error) {
      console.error("[admin-businesses] list error:", error.message);
      return serverError();
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "BUSINESSES_LISTED",
      ipAddress: getCallerIp(req),
    });

    return adminJson({
      data,
      total: count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    console.error("[admin-businesses]", err);
    return serverError();
  }
}));
