// ALLOWED_ORIGIN accepts a comma-separated list (set via `supabase secrets set`).
// Falls back to both canonical production domains so a missing secret is never
// silently open. We always include both apex and www variants.
const configuredOrigins = (
  Deno.env.get("ALLOWED_ORIGIN") ?? "https://kazione.app,https://www.kazione.app"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Local Supabase dev (port 54321) is always allowed so developers don't need
// to configure secrets locally.
const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
];

const ALLOWED_ORIGINS = new Set([...configuredOrigins, ...DEV_ORIGINS]);

const BASE_CORS_HEADERS = {
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

/**
 * Returns CORS headers with the correct Allow-Origin for the given request.
 * If the request origin is in the allowlist it is echoed back (required for
 * credentialed requests). Unknown origins fall back to the first configured
 * origin so the preflight still returns a valid header value.
 */
export function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowedOrigin = ALLOWED_ORIGINS.has(origin)
    ? origin
    : configuredOrigins[0];
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    ...BASE_CORS_HEADERS,
  };
}

// Legacy export — keeps existing edge functions working without changes.
// Points at the first configured origin; use corsHeadersFor(req) in new code.
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": configuredOrigins[0],
  ...BASE_CORS_HEADERS,
};

/**
 * Handle CORS preflight. Returns a 204 Response for OPTIONS requests,
 * or null so the caller can continue with the actual handler.
 */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeadersFor(req),
    });
  }
  return null;
}

/**
 * Convenience wrapper — returns a JSON Response with origin-aware CORS headers.
 * Prefer this over manually spreading corsHeaders so www vs apex mismatches
 * are handled automatically.
 */
export function jsonCors(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}
