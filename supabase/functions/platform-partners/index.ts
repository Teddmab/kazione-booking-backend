import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors } from "../_shared/cors.ts";
import { serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

function json(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeadersFor(req),
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
}

/**
 * GET /platform-partners — public, no auth required.
 *
 * Returns only enabled partner logos, ordered for display. The client
 * hides the partner strip entirely when this list is empty — never invents
 * placeholder brands.
 */
Deno.serve(withLogging("platform-partners", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET") {
    return json(req, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed" } }, 405);
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("platform_partners")
      .select("id, name, logo_url, website_url")
      .eq("is_enabled", true)
      .order("display_order", { ascending: true });

    if (error) return serverError(req, error.message);

    return json(req, { partners: data ?? [] });
  } catch (err) {
    console.error("platform-partners error:", err);
    return serverError(req, err instanceof Error ? err.message : "Internal error");
  }
}));
