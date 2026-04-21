import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
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

  if (req.method !== "GET" && req.method !== "PATCH") {
    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Only GET and PATCH are allowed" } }, 405);
  }

  try {
    const user = await verifyAuth(req);

    if (req.method === "PATCH") {
      const body = await req.json().catch(() => null) as {
        first_name?: string | null;
        last_name?: string | null;
        phone?: string | null;
      } | null;

      if (!body) {
        return badRequest("Invalid JSON body");
      }

      const normalize = (value: string | null | undefined, maxLen: number) => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        const trimmed = value.trim();
        if (!trimmed) return null;
        return trimmed.slice(0, maxLen);
      };

      const updatePayload: {
        first_name?: string | null;
        last_name?: string | null;
        phone?: string | null;
      } = {};

      const firstName = normalize(body.first_name, 100);
      const lastName = normalize(body.last_name, 100);
      const phone = normalize(body.phone, 30);

      if (firstName !== undefined) updatePayload.first_name = firstName;
      if (lastName !== undefined) updatePayload.last_name = lastName;
      if (phone !== undefined) updatePayload.phone = phone;

      if (Object.keys(updatePayload).length === 0) {
        return badRequest("No profile fields provided");
      }

      const { data: updatedProfile, error: updateErr } = await supabaseAdmin
        .from("users")
        .update(updatePayload)
        .eq("id", user.id)
        .select("id, first_name, last_name, email, phone, avatar_url")
        .maybeSingle();

      if (updateErr) throw updateErr;

      return json({ profile: updatedProfile ?? null });
    }

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
