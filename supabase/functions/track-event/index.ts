import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors } from "../_shared/cors.ts";
import { badRequest } from "../_shared/errors.ts";

// Public endpoint — no auth required — used by the storefront to track page views.
// Fails silently on the client side; 204 even on errors to avoid breaking the page.

Deno.serve(async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  try {
    const body = await req.json();
    const { business_id, page, referrer, utm_source, utm_medium, utm_campaign } = body as Record<string, string | undefined>;

    if (!business_id || !page) {
      return new Response(null, { status: 204, headers: corsHeadersFor(req) });
    }

    await supabaseAdmin.from("storefront_page_views").insert({
      business_id,
      page,
      referrer: referrer || null,
      utm_source: utm_source || null,
      utm_medium: utm_medium || null,
      utm_campaign: utm_campaign || null,
    });
  } catch (err) {
    console.error("track-event error:", err);
  }

  return new Response(null, { status: 204, headers: corsHeadersFor(req) });
});
