import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { verifyAuth } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * /notifications — notifications for the authenticated user
 *
 * GET                        → list notifications (auth required, uses JWT user_id)
 * PATCH ?id=                 → mark single notification as read
 * POST  ?action=mark-all-read → mark all unread as read
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

      const { data, error } = await supabaseAdmin
        .from("notifications")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) return serverError(error.message);
      return json(data ?? []);
    }

    if (method === "PATCH") {
      if (!id) return badRequest("id is required");

      const { error } = await supabaseAdmin
        .from("notifications")
        .update({ is_read: true })
        .eq("id", id)
        .eq("user_id", user.id); // ensure user can only mark their own

      if (error) return serverError(error.message);
      return json({ ok: true });
    }

    if (method === "POST" && action === "mark-all-read") {
      const { error } = await supabaseAdmin
        .from("notifications")
        .update({ is_read: true })
        .eq("user_id", user.id)
        .eq("is_read", false);

      if (error) return serverError(error.message);
      return json({ ok: true });
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("notifications error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
