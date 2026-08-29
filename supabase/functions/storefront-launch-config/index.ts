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
      // Short max-age so a republish from Admin is visible quickly, matching
      // marketplace-storefronts/get-availability's max-age-only convention
      // (no ETag/webhook invalidation exists in this backend).
      "Cache-Control": "public, max-age=30",
    },
  });
}

/**
 * GET /storefront-launch-config — public, no auth required.
 *
 * Returns only the currently PUBLISHED client landing-page launch/countdown
 * config — draft configuration never leaves admin-storefront-launch-config.
 * Localized fields (heroSlides[].eyebrow/title/description/statusText) are
 * returned as raw { en, et, fr, ru } objects; the client resolves its own
 * locale, matching this repo's existing i18n fallback convention and
 * keeping this response cacheable for every locale at once.
 *
 * If nothing has ever been published, returns { configured: false } (not an
 * error) so the client can render its safe fallback instead of a fake
 * countdown or an assumed-live marketplace.
 */
Deno.serve(withLogging("storefront-launch-config", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET") {
    return json(req, { error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed" } }, 405);
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("platform_storefront_launch_config")
      .select("published, version")
      .eq("id", 1)
      .maybeSingle();

    if (error) return serverError(req, error.message);

    if (!data?.published) {
      return json(req, { configured: false });
    }

    return json(req, { configured: true, version: data.version, ...data.published });
  } catch (err) {
    console.error("storefront-launch-config error:", err);
    return serverError(req, err instanceof Error ? err.message : "Internal error");
  }
}));
