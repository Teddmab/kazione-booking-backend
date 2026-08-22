import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson } from "../_shared/adminCors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { requirePlatformAdmin, getCallerIp } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { withLogging } from "../_shared/logger.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * /admin-alert-settings — platform-admin config for outage/error alert email
 *
 * GET    → current alert_email (null if never configured — no alerts send
 *          until a platform admin sets one, deliberately no hardcoded default)
 * PATCH  body={alert_email}  → update it (empty string clears it)
 */
Deno.serve(withLogging("admin-alert-settings", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  if (req.method === "PATCH") {
    let body: { alert_email?: string };
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    if (typeof body.alert_email !== "string") {
      return badRequest("alert_email (string) is required — pass an empty string to clear it");
    }

    const trimmed = body.alert_email.trim();
    if (trimmed && !EMAIL_RE.test(trimmed)) {
      return badRequest("alert_email is not a valid email address");
    }

    const { data, error } = await supabaseAdmin
      .from("platform_alert_settings")
      .update({
        alert_email: trimmed || null,
        updated_at: new Date().toISOString(),
        updated_by: ctx.adminId,
      })
      .eq("id", 1)
      .select("alert_email, updated_at")
      .single();

    if (error) {
      console.error("[admin-alert-settings] update error:", error.message);
      return serverError();
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "ALERT_SETTINGS_UPDATED",
      targetMeta: { alert_email: trimmed || null },
      ipAddress: getCallerIp(req),
    });

    return adminJson(data);
  }

  // ── GET ────────────────────────────────────────────────────────────────
  const { data, error } = await supabaseAdmin
    .from("platform_alert_settings")
    .select("alert_email, updated_at")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error("[admin-alert-settings] fetch error:", error.message);
    return serverError();
  }

  return adminJson(data ?? { alert_email: null, updated_at: null });
}));
