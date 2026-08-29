import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { verifyAuth } from "../_shared/auth.ts";
import { isExpoPushToken } from "../_shared/expoPushToken.ts";

/**
 * /notifications — notifications for the authenticated user
 *
 * GET                              → list notifications (JWT user_id)
 * PATCH ?id=                       → mark single notification as read
 * POST  ?action=mark-all-read      → mark all unread as read
 * POST  ?action=register-push-token   → upsert Expo push token for this user
 * POST  ?action=unregister-push-token → delete Expo push token for this user
 */
Deno.serve(withLogging("notifications", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");
  const id = url.searchParams.get("id");

  try {
    const user = await verifyAuth(req);

    if (method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
      const typeFilter = url.searchParams.get("type");

      let query = supabaseAdmin
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (typeFilter) {
        query = query.eq("type", typeFilter);
      }

      const { data, error } = await query;

      if (error) return serverError(error.message);
      return jsonCors(req, data ?? []);
    }

    if (method === "PATCH") {
      if (!id) return badRequest("id is required");

      const { error } = await supabaseAdmin
        .from("notifications")
        .update({ is_read: true })
        .eq("id", id)
        .eq("user_id", user.id);

      if (error) return serverError(error.message);
      return jsonCors(req, { ok: true });
    }

    if (method === "POST" && action === "mark-all-read") {
      const { error } = await supabaseAdmin
        .from("notifications")
        .update({ is_read: true })
        .eq("user_id", user.id)
        .eq("is_read", false);

      if (error) return serverError(error.message);
      return jsonCors(req, { ok: true });
    }

    if (method === "POST" && action === "register-push-token") {
      const body = await req.json().catch(() => null) as {
        token?: unknown;
        platform?: unknown;
        app_variant?: unknown;
      } | null;

      const token = typeof body?.token === "string" ? body.token.trim() : "";
      const platform = body?.platform === "ios" || body?.platform === "android"
        ? body.platform
        : null;
      const appVariant =
        typeof body?.app_variant === "string" && body.app_variant.trim()
          ? body.app_variant.trim()
          : "staff";

      if (!token || !isExpoPushToken(token)) {
        return badRequest("valid Expo push token is required");
      }
      if (!platform) {
        return badRequest("platform must be ios or android");
      }

      const { error } = await supabaseAdmin.from("device_push_tokens").upsert(
        {
          user_id: user.id,
          expo_push_token: token,
          platform,
          app_variant: appVariant,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,expo_push_token" },
      );

      if (error) return serverError(error.message);
      return jsonCors(req, { ok: true });
    }

    if (method === "POST" && action === "unregister-push-token") {
      const body = await req.json().catch(() => null) as {
        token?: unknown;
      } | null;
      const token = typeof body?.token === "string" ? body.token.trim() : "";
      if (!token) return badRequest("token is required");

      const { error } = await supabaseAdmin
        .from("device_push_tokens")
        .delete()
        .eq("user_id", user.id)
        .eq("expo_push_token", token);

      if (error) return serverError(error.message);
      return jsonCors(req, { ok: true });
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("notifications error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
