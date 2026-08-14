import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

// Public (no auth) endpoint — returns active help items for a given route.
// Owner and staff portals call this to power HelpIcon buttons.

Deno.serve(withLogging("public-help", async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "GET") return badRequest("Method not allowed");

  const url = new URL(req.url);
  const targetPath = url.searchParams.get("target_path");
  const portal = url.searchParams.get("portal"); // "owner" | "staff" | null (any)

  if (!targetPath) return badRequest("target_path is required");

  let query = supabaseAdmin
    .from("contextual_help")
    .select("id, title, description, video_url, quiz_json, target_path, target_section, target_element, portal")
    .eq("target_path", targetPath)
    .eq("is_active", true);

  if (portal) {
    query = query.in("portal", [portal, "both"]);
  }

  const { data, error } = await query.order("created_at", { ascending: true });

  if (error) {
    console.error("[public-help] error:", error.message);
    return serverError();
  }

  return jsonCors(req, { data: data ?? [] });
}));
