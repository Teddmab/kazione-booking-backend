import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson, adminErrors } from "../_shared/adminCors.ts";
import { requirePlatformAdmin, getCallerIp } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { withLogging } from "../_shared/logger.ts";

const SELECT_FIELDS = "id, name, logo_url, website_url, is_enabled, display_order, created_at, updated_at";

/**
 * /admin-partners — platform-admin CRUD for the client landing page's
 * partner-logo strip.
 *
 * GET            → all partners, ordered by display_order
 * POST   body={name, logo_url, website_url?, is_enabled?, display_order?}
 * PATCH  ?id=<uuid>  body=<partial fields>
 * DELETE ?id=<uuid>
 */
Deno.serve(withLogging("admin-partners", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (req.method === "POST") {
    let body: { name?: string; logo_url?: string; website_url?: string; is_enabled?: boolean; display_order?: number };
    try {
      body = await req.json();
    } catch {
      return adminErrors.badRequest("Invalid JSON body");
    }

    if (!body.name?.trim() || !body.logo_url?.trim()) {
      return adminErrors.badRequest("name and logo_url are required");
    }

    const { data, error } = await supabaseAdmin
      .from("platform_partners")
      .insert({
        name: body.name.trim(),
        logo_url: body.logo_url.trim(),
        website_url: body.website_url?.trim() || null,
        is_enabled: body.is_enabled ?? true,
        display_order: body.display_order ?? 0,
        updated_by: ctx.adminId,
      })
      .select(SELECT_FIELDS)
      .single();

    if (error) {
      console.error("[admin-partners] insert error:", error.message);
      return adminErrors.serverError(error.message);
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "PARTNER_CREATED",
      targetId: data.id,
      targetMeta: { name: data.name },
      ipAddress: getCallerIp(req),
    });

    return adminJson(data, 201);
  }

  if (req.method === "PATCH") {
    if (!id) return adminErrors.badRequest("id query param is required");

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return adminErrors.badRequest("Invalid JSON body");
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: ctx.adminId };
    for (const field of ["name", "logo_url", "website_url", "is_enabled", "display_order"]) {
      if (field in body) update[field] = body[field];
    }

    const { data, error } = await supabaseAdmin
      .from("platform_partners")
      .update(update)
      .eq("id", id)
      .select(SELECT_FIELDS)
      .maybeSingle();

    if (error) {
      console.error("[admin-partners] update error:", error.message);
      return adminErrors.serverError(error.message);
    }
    if (!data) return adminErrors.notFound(`Partner '${id}' not found`);

    logAdminAction({
      adminId: ctx.adminId,
      action: "PARTNER_UPDATED",
      targetId: id,
      targetMeta: update,
      ipAddress: getCallerIp(req),
    });

    return adminJson(data);
  }

  if (req.method === "DELETE") {
    if (!id) return adminErrors.badRequest("id query param is required");

    const { error } = await supabaseAdmin.from("platform_partners").delete().eq("id", id);
    if (error) {
      console.error("[admin-partners] delete error:", error.message);
      return adminErrors.serverError(error.message);
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "PARTNER_DELETED",
      targetId: id,
      ipAddress: getCallerIp(req),
    });

    return adminJson({ id });
  }

  // ── GET ────────────────────────────────────────────────────────────────
  const { data, error } = await supabaseAdmin
    .from("platform_partners")
    .select(SELECT_FIELDS)
    .order("display_order", { ascending: true });

  if (error) {
    console.error("[admin-partners] fetch error:", error.message);
    return adminErrors.serverError(error.message);
  }

  return adminJson({ partners: data ?? [] });
}));
