import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson } from "../_shared/adminCors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { requirePlatformAdmin } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { getCallerIp } from "../_shared/adminAuth.ts";
import { withLogging } from "../_shared/logger.ts";

Deno.serve(withLogging("admin-regions", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  // ── PATCH: toggle is_enabled for a country ───────────────────────────────
  if (req.method === "PATCH") {
    let body: { country_code?: string; is_enabled?: boolean; notes?: string };
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    if (!body.country_code || typeof body.is_enabled !== "boolean") {
      return badRequest("country_code and is_enabled (boolean) are required");
    }

    const now = new Date().toISOString();
    const update: Record<string, unknown> = {
      is_enabled: body.is_enabled,
      enabled_at: body.is_enabled ? now : null,
      enabled_by_id: body.is_enabled ? ctx.adminId : null,
    };
    if (typeof body.notes === "string") update.notes = body.notes;

    const { data, error } = await supabaseAdmin
      .from("platform_regions")
      .update(update)
      .eq("country_code", body.country_code.toUpperCase())
      .select("country_code, country_name, is_enabled, enabled_at, notes")
      .maybeSingle();

    if (error) {
      console.error("[admin-regions] patch error:", error.message);
      return serverError();
    }
    if (!data) return badRequest(`Country '${body.country_code}' not found in platform_regions`);

    logAdminAction({
      adminId: ctx.adminId,
      action: body.is_enabled ? "REGION_ENABLED" : "REGION_DISABLED",
      targetType: "business",
      targetId: body.country_code.toUpperCase(),
      targetMeta: { country_name: (data as Record<string, unknown>).country_name },
      ipAddress: getCallerIp(req),
    });

    return adminJson(data);
  }

  // ── GET: all regions with business counts ────────────────────────────────
  try {
    const [{ data: regions, error: regError }, { data: businesses, error: bizError }] =
      await Promise.all([
        supabaseAdmin
          .from("platform_regions")
          .select("country_code, country_name, is_enabled, enabled_at, notes, created_at")
          .order("country_name", { ascending: true }),
        supabaseAdmin
          .from("businesses")
          .select("country, is_active"),
      ]);

    if (regError || bizError) {
      console.error("[admin-regions] fetch error:", regError?.message ?? bizError?.message);
      return serverError();
    }

    // Count businesses per country
    const countMap = new Map<string, { total: number; active: number }>();
    for (const b of businesses ?? []) {
      const code = ((b as Record<string, unknown>).country as string | null)?.toUpperCase();
      if (!code) continue;
      const agg = countMap.get(code) ?? { total: 0, active: 0 };
      agg.total += 1;
      if ((b as Record<string, unknown>).is_active) agg.active += 1;
      countMap.set(code, agg);
    }

    const result = (regions ?? []).map((r: Record<string, unknown>) => {
      const counts = countMap.get(r.country_code as string) ?? { total: 0, active: 0 };
      return {
        ...r,
        business_count: counts.total,
        active_business_count: counts.active,
      };
    });

    return adminJson({ regions: result });
  } catch (err) {
    console.error("[admin-regions]", err);
    return serverError();
  }
}));
