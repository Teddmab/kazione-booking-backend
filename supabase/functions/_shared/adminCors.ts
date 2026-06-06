const adminOrigin =
  Deno.env.get("ADMIN_ALLOWED_ORIGIN") ?? "https://admin.kazione.app";

export const adminCorsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": adminOrigin,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

export function handleAdminCors(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: adminCorsHeaders });
  }
  return null;
}

export function adminJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...adminCorsHeaders, "Content-Type": "application/json" },
  });
}
