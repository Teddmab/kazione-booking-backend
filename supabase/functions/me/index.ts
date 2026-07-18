import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { verifyAuth } from "../_shared/auth.ts";

/**
 * GET /me — Returns authenticated user's profile + all business memberships.
 * PATCH /me — Updates first_name, last_name, phone.
 *
 * GET response:
 *   { profile: { id, first_name, last_name, email, phone, avatar_url } | null,
 *     tenant: { businessId, businessName, slug, role } | null,
 *     businesses: { businessId, businessName, slug, role }[] }
 */
Deno.serve(withLogging("me", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET" && req.method !== "PATCH") {
    return jsonCors(req, {
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Only GET and PATCH are allowed",
      },
    }, 405);
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

      return jsonCors(req, { profile: updatedProfile ?? null });
    }

    const [profileResult, membershipsResult] = await Promise.all([
      supabaseAdmin
        .from("users")
        .select("id, first_name, last_name, email, phone, avatar_url")
        .eq("id", user.id)
        .maybeSingle(),
      supabaseAdmin
        .from("business_members")
        .select("id, business_id, role, businesses(name, slug, business_type, logo_url, country)")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .order("created_at", { ascending: true }),
    ]);

    const profile = profileResult.data ?? null;
    const memberships = (membershipsResult.data ?? []) as unknown as Array<{
      id: string;
      business_id: string;
      role: string;
      businesses: { name: string; slug: string; business_type: string | null; logo_url: string | null; country: string | null } | null;
    }>;

    // Fetch linked staff profiles so we can surface position + staffProfileId
    // (staff_profiles.business_member_id → business_members.id)
    const memberIds = memberships.map((m) => m.id);
    const staffProfileMap = new Map<
      string,
      { id: string; position: string | null }
    >();
    if (memberIds.length > 0) {
      const { data: spRows } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_member_id, position")
        .in("business_member_id", memberIds)
        .eq("is_active", true);
      for (const sp of spRows ?? []) {
        const row = sp as { id: string; business_member_id: string; position: string | null };
        staffProfileMap.set(row.business_member_id, {
          id: row.id,
          position: row.position ?? null,
        });
      }
    }

    const businesses = memberships.map((m) => {
      const sp = staffProfileMap.get(m.id) ?? null;
      return {
        businessId: m.business_id,
        businessName: m.businesses?.name ?? "",
        slug: m.businesses?.slug ?? "",
        businessType: m.businesses?.business_type ?? null,
        logoUrl: m.businesses?.logo_url ?? null,
        country: m.businesses?.country ?? null,
        role: m.role,
        staffProfileId: sp?.id ?? null,
        position: sp?.position ?? null,
      };
    });

    const tenant = businesses.length > 0 ? businesses[0] : null;

    return jsonCors(req, { profile, tenant, businesses });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("me error:", e);
    return serverError("Failed to load user data");
  }
}));
