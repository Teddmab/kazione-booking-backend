import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson } from "../_shared/adminCors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { requirePlatformAdmin, getCallerIp } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { withLogging } from "../_shared/logger.ts";

/**
 * /admin-reviews — platform-admin review moderation
 *
 * GET   ?[business_id=&is_public=&rating=&page=&limit=]  → paginated list across all businesses
 * PATCH ?id=  body={is_public, reason}                   → hide/unhide any review
 */
Deno.serve(withLogging("admin-reviews", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);

  // ── PATCH: hide/unhide any review ─────────────────────────────────────────
  if (req.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return badRequest("id is required");

    let body: { is_public?: boolean; reason?: string };
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    if (typeof body.is_public !== "boolean") return badRequest("is_public (boolean) is required");
    if (!body.reason || !body.reason.trim()) return badRequest("reason is required");

    const { data, error } = await supabaseAdmin
      .from("reviews")
      .update({
        is_public: body.is_public,
        moderated_by: ctx.adminId,
        moderated_at: new Date().toISOString(),
        moderation_reason: body.reason,
      })
      .eq("id", id)
      .select("id, business_id, is_public")
      .single();

    if (error) {
      console.error("[admin-reviews] update error:", error.message);
      return serverError();
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: body.is_public ? "REVIEW_UNHIDDEN" : "REVIEW_HIDDEN",
      targetType: "review",
      targetId: id,
      targetMeta: { business_id: data.business_id, reason: body.reason },
      ipAddress: getCallerIp(req),
    });

    return adminJson(data);
  }

  // ── GET: paginated list across all businesses ─────────────────────────────
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "25", 10)));
  const businessId = url.searchParams.get("business_id");
  const isPublicParam = url.searchParams.get("is_public"); // "true" | "false"
  const rating = url.searchParams.get("rating");
  const offset = (page - 1) * limit;

  try {
    let query = supabaseAdmin
      .from("reviews")
      .select(
        `id, business_id, rating, comment, reviewer_name, is_public, owner_reply,
         moderated_at, moderation_reason, created_at,
         business:businesses(name, slug),
         client:clients(first_name, last_name)`,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (businessId) query = query.eq("business_id", businessId);
    if (isPublicParam === "true") query = query.eq("is_public", true);
    if (isPublicParam === "false") query = query.eq("is_public", false);
    if (rating) query = query.eq("rating", parseInt(rating, 10));

    const { data, count, error } = await query;
    if (error) {
      console.error("[admin-reviews] list error:", error.message);
      return serverError();
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "REVIEWS_LISTED",
      ipAddress: getCallerIp(req),
    });

    return adminJson({
      data,
      total: count ?? 0,
      page,
      limit,
    });
  } catch (err) {
    console.error("[admin-reviews]", err);
    return serverError();
  }
}));
