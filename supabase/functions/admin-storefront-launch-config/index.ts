import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson, adminErrors } from "../_shared/adminCors.ts";
import { requirePlatformAdmin, getCallerIp } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { withLogging } from "../_shared/logger.ts";

interface LaunchConfigBody {
  launch_at?: string | null;
  launch_timezone?: string | null;
  countdown_visible?: boolean;
}

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * /admin-storefront-launch-config — platform-admin config for the client
 * landing page's launch countdown. Deliberately minimal: launch date,
 * timezone, and countdown visibility only — everything else on the landing
 * page is fixed client-side content, not admin-editable.
 *
 * GET    → current { launch_at, launch_timezone, countdown_visible, updated_at }
 * PATCH  body={launch_at?, launch_timezone?, countdown_visible?} → update
 */
Deno.serve(withLogging("admin-storefront-launch-config", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  if (req.method === "PATCH") {
    let body: LaunchConfigBody;
    try {
      body = await req.json();
    } catch {
      return adminErrors.badRequest("Invalid JSON body");
    }

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("platform_storefront_launch_config")
      .select("launch_at, launch_timezone, countdown_visible")
      .eq("id", 1)
      .single();

    if (fetchError) {
      console.error("[admin-storefront-launch-config] fetch error:", fetchError.message);
      return adminErrors.serverError(fetchError.message);
    }

    const next = {
      launch_at: body.launch_at !== undefined ? body.launch_at : existing.launch_at,
      launch_timezone: body.launch_timezone !== undefined ? body.launch_timezone : existing.launch_timezone,
      countdown_visible: body.countdown_visible !== undefined ? body.countdown_visible : existing.countdown_visible,
    };

    if (next.launch_at !== null && next.launch_at !== undefined && Number.isNaN(Date.parse(next.launch_at))) {
      return adminErrors.badRequest("launch_at is not a valid ISO 8601 instant");
    }
    if (next.launch_timezone && !isValidTimezone(next.launch_timezone)) {
      return adminErrors.badRequest(`launch_timezone "${next.launch_timezone}" is not a recognized IANA timezone`);
    }
    if (next.countdown_visible && (!next.launch_at || !next.launch_timezone)) {
      return adminErrors.badRequest("launch_at and launch_timezone are required when countdown_visible is true");
    }

    const { data, error } = await supabaseAdmin
      .from("platform_storefront_launch_config")
      .update({ ...next, updated_at: new Date().toISOString(), updated_by: ctx.adminId })
      .eq("id", 1)
      .select("launch_at, launch_timezone, countdown_visible, updated_at")
      .single();

    if (error) {
      console.error("[admin-storefront-launch-config] update error:", error.message);
      return adminErrors.serverError(error.message);
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "STOREFRONT_LAUNCH_CONFIG_UPDATED",
      targetMeta: next,
      ipAddress: getCallerIp(req),
    });

    return adminJson(data);
  }

  // ── GET ────────────────────────────────────────────────────────────────
  const { data, error } = await supabaseAdmin
    .from("platform_storefront_launch_config")
    .select("launch_at, launch_timezone, countdown_visible, updated_at")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error("[admin-storefront-launch-config] fetch error:", error.message);
    return adminErrors.serverError(error.message);
  }

  return adminJson(data ?? { launch_at: null, launch_timezone: null, countdown_visible: false, updated_at: null });
}));
