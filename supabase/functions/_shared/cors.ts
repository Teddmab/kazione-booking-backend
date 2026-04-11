// Restrict origin to ALLOWED_ORIGIN env var (set via `supabase secrets set`).
// Falls back to the production domain so a missing secret is never silently open.
const allowedOrigin =
  Deno.env.get("ALLOWED_ORIGIN") ?? "https://app.kazione.com";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

/**
 * Handle CORS preflight. Returns a 204 Response for OPTIONS requests,
 * or null so the caller can continue with the actual handler.
 */
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return null;
}
