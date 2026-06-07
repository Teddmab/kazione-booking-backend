// Origins allowed to call admin functions. Hardcoded so CORS works
// even if the ADMIN_ALLOWED_ORIGIN secret isn't propagated yet.
const ALLOWED_ORIGINS = new Set<string>([
  "https://kazione-booking-admin.pages.dev",
  "https://admin.kazione.app",
  ...(Deno.env.get("ADMIN_ALLOWED_ORIGIN")
    ? [Deno.env.get("ADMIN_ALLOWED_ORIGIN") as string]
    : []),
]);

const DEFAULT_ORIGIN = "https://kazione-booking-admin.pages.dev";

// Set per-request by handleAdminCors; adminJson reads it so the reflected
// origin is correct without changing any function signatures.
let _origin = DEFAULT_ORIGIN;

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : DEFAULT_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  };
}

export const adminCorsHeaders: Record<string, string> = corsHeaders(DEFAULT_ORIGIN);

export function handleAdminCors(req: Request): Response | null {
  _origin = req.headers.get("origin") ?? DEFAULT_ORIGIN;
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(_origin) });
  }
  return null;
}

export function adminJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(_origin), "Content-Type": "application/json" },
  });
}

// Admin-aware error helpers — use these in admin shared code (adminAuth, etc.)
// so error responses carry the correct CORS origin instead of the main app origin.
function adminError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { ...corsHeaders(_origin), "Content-Type": "application/json" },
  });
}

export const adminErrors = {
  unauthorized: (message = "Unauthorized") => adminError(401, "UNAUTHORIZED", message),
  forbidden: (message = "Forbidden") => adminError(403, "FORBIDDEN", message),
  serverError: (message = "Internal server error") => adminError(500, "INTERNAL_ERROR", message),
};
