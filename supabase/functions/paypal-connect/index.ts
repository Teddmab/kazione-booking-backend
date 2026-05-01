/// <reference path="../_shared/deno-globals.d.ts" />

import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Stub — PayPal Connect is not yet implemented.
// Returns a consistent "coming_soon" shape so the SettingsPage stops 404ing.
// ---------------------------------------------------------------------------

Deno.serve(withLogging("paypal-connect", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  // Support both GET (status check) and POST (all actions)
  if (req.method !== "GET" && req.method !== "POST") {
    return badRequest("Only GET and POST are supported");
  }

  try {
    let businessId: string | undefined;

    if (req.method === "GET") {
      businessId = new URL(req.url).searchParams.get("business_id") ?? undefined;
    } else {
      const body = await req.json() as Record<string, unknown>;
      businessId = body.business_id as string | undefined;
    }

    if (!businessId) return badRequest("business_id is required");

    const ctx = await requireOwnerOrManagerCtx(req, businessId);
    if (ctx instanceof Response) return ctx;

    return json({
      status: "coming_soon",
      connected: false,
      paypal_email: null,
      merchant_id: null,
    });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[paypal-connect] Unhandled error:", err);
    return serverError(err instanceof Error ? err.message : "Internal server error");
  }
}));
