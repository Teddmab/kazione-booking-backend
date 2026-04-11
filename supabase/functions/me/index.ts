import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { verifyAuth } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * GET /me
 * Returns the authenticated user's profile and primary tenant (business membership).
 *
 * Response shape:
 *   { profile: { id, first_name, last_name, email, phone, avatar_url } | null,
 *     tenant: { businessId, businessName, role } | null }
 */
Deno.serve(withLogging("me", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET") {
    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Only GET is allowed" } }, 405);
  }

  try {
    const user = await verifyAuth(req);

    const [profileResult, membershipResult] = await Promise.all([
      supabaseAdmin
        .from("users")
        .select("id, first_name, last_name, email, phone, avatar_url")
        .eq("id", user.id)
        .maybeSingle(),
      supabaseAdmin
        .from("business_members")
        .select("business_id, role, businesses(name)")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle(),
    ]);

    const profile = profileResult.data ?? null;
    const membership = membershipResult.data ?? null;

    let tenant = null;
    if (membership) {
      const biz = membership.businesses as unknown as { name: string } | null;
      tenant = {
        businessId: membership.business_id as string,
        businessName: biz?.name ?? "",
        role: membership.role as string,
      };
    }

    return json({ profile, tenant });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("me error:", e);
    return serverError("Failed to load user data");
  }
}));
