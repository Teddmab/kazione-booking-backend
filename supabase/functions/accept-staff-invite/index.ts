import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { verifyAuth } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

interface MembershipOption {
  business_id: string;
  business_name: string;
  logo_url: string | null;
  role: string;
  dashboard: string;
}

async function fetchMemberships(userId: string): Promise<MembershipOption[]> {
  const { data } = await supabaseAdmin
    .from("business_members")
    .select("role, business_id, businesses(name, logo_url)")
    .eq("user_id", userId)
    .eq("is_active", true);

  return (data ?? []).map((m: Record<string, unknown>) => {
    const biz = m.businesses as { name: string; logo_url: string | null } | null;
    const role = m.role as string;
    return {
      business_id: m.business_id as string,
      business_name: biz?.name ?? "Business",
      logo_url: biz?.logo_url ?? null,
      role,
      dashboard: ["owner", "manager"].includes(role) ? "/owner" : "/staff",
    };
  });
}

/**
 * POST /accept-staff-invite
 *
 * Called by AuthCallbackPage immediately after the staff member's magic link
 * is exchanged for a session. Activates the pending staff_profiles and
 * business_members rows so the owner sees them as "active" instead of
 * "pending confirmation".
 *
 * Body: { staff_profile_id: string }
 * Auth: Bearer JWT of the newly-signed-in staff member
 *
 * Returns: { success, business_id, role, memberships[] } — memberships lists
 * ALL of the user's active workspaces so the frontend can show a role picker
 * when the user belongs to more than one business.
 *
 * Idempotent — safe to call even if already active.
 */
Deno.serve(withLogging("accept-staff-invite", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return jsonCors(req, { error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is allowed" } }, 405);
  }

  try {
    const body = await req.json() as { staff_profile_id?: string };
    if (!body.staff_profile_id) return badRequest("staff_profile_id is required");

    // Verify the caller — this is the just-logged-in staff member
    const user = await verifyAuth(req);

    // Fetch the staff profile
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from("staff_profiles")
      .select("id, business_id, business_member_id, invited_email, is_active")
      .eq("id", body.staff_profile_id)
      .maybeSingle();

    if (profileErr) throw profileErr;
    if (!profile) return notFound("Staff invitation not found");

    const sp = profile as Record<string, unknown>;

    // Idempotent — return success immediately if already active
    if (sp.is_active) {
      const memberships = await fetchMemberships(user.id);
      const thisRole = memberships.find((m) => m.business_id === sp.business_id as string)?.role ?? "staff";
      return jsonCors(req, {
        success: true,
        already_active: true,
        business_id: sp.business_id,
        role: thisRole,
        memberships,
      });
    }

    // Security: the logged-in user's email must match the invited_email on the profile
    const invitedEmail = (sp.invited_email as string | null)?.toLowerCase();
    const userEmail = user.email?.toLowerCase();
    if (!invitedEmail || !userEmail || invitedEmail !== userEmail) {
      return forbidden("This invitation was not sent to your email address");
    }

    const businessId = sp.business_id as string;
    let memberId = sp.business_member_id as string | null;

    let memberRole = "staff";

    if (memberId) {
      // Member row already exists (user existed at invite time): activate it
      // and ensure user_id is linked (in case it was null).
      const { data: updatedMember, error: memberErr } = await supabaseAdmin
        .from("business_members")
        .update({
          is_active: true,
          user_id: user.id,
          joined_at: new Date().toISOString(),
        })
        .eq("id", memberId)
        .select("role")
        .single();
      if (memberErr) throw memberErr;
      memberRole = (updatedMember as Record<string, unknown>).role as string ?? "staff";
    } else {
      // User didn't exist at invite time — create the member row now
      const { data: newMember, error: memberErr } = await supabaseAdmin
        .from("business_members")
        .insert({
          business_id: businessId,
          user_id: user.id,
          role: "staff",
          is_active: true,
          joined_at: new Date().toISOString(),
        })
        .select("id, role")
        .single();
      if (memberErr) throw memberErr;

      memberId = (newMember as Record<string, unknown>).id as string;
      memberRole = (newMember as Record<string, unknown>).role as string ?? "staff";

      // Link the staff profile to the new member row
      await supabaseAdmin
        .from("staff_profiles")
        .update({ business_member_id: memberId })
        .eq("id", body.staff_profile_id);
    }

    // Activate the staff profile
    const { error: activateErr } = await supabaseAdmin
      .from("staff_profiles")
      .update({ is_active: true })
      .eq("id", body.staff_profile_id);
    if (activateErr) throw activateErr;

    // Fetch all of the user's active memberships for multi-role routing on the frontend
    const memberships = await fetchMemberships(user.id);

    return jsonCors(req, { success: true, business_id: businessId, role: memberRole, memberships });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("accept-staff-invite error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
