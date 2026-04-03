import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, conflict, serverError } from "../_shared/errors.ts";
import { verifyAuth, requireOwnerOrManager } from "../_shared/auth.ts";
import { sendEmail, staffInviteEmail } from "../_shared/resend.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InviteBody {
  business_id: string;
  email: string;
  display_name: string;
  role: string;
  specialties?: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("invite-staff", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  try {
    // ── Auth: owner or manager only ───────────────────────────────────────
    const user = await verifyAuth(req);
    const body: InviteBody = await req.json();

    // ── Validate ──────────────────────────────────────────────────────────
    if (!body.business_id) return badRequest("business_id is required");
    if (!body.email) return badRequest("email is required");
    if (!EMAIL_RE.test(body.email)) return badRequest("Invalid email address");
    if (!body.display_name) return badRequest("display_name is required");

    const role = body.role ?? "staff";
    if (!["owner", "manager", "staff", "receptionist"].includes(role)) {
      return badRequest("role must be owner, manager, staff, or receptionist");
    }

    await requireOwnerOrManager(user.id, body.business_id);

    // ── Check for existing membership ─────────────────────────────────────
    // Look up by email in users table
    const { data: existingUser, error: userErr } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("email", body.email.toLowerCase())
      .maybeSingle();
    if (userErr) throw userErr;

    if (existingUser) {
      const { data: existingMember, error: memberErr } = await supabaseAdmin
        .from("business_members")
        .select("id, is_active")
        .eq("business_id", body.business_id)
        .eq("user_id", existingUser.id)
        .maybeSingle();
      if (memberErr) throw memberErr;

      if (existingMember) {
        if (existingMember.is_active) {
          return conflict(
            "ALREADY_MEMBER",
            "This email is already an active member of this business",
          );
        }
        // Re-activate if previously deactivated
        await supabaseAdmin
          .from("business_members")
          .update({
            is_active: false,
            role,
            invited_at: new Date().toISOString(),
          })
          .eq("id", existingMember.id);
      }
    }

    // ── INSERT business_members (inactive until invite accepted) ──────────
    let memberId: string | null = null;

    if (!existingUser) {
      // No user account yet — create a pending member without user_id
      // The member will be linked when they accept the invite and sign up
      // For now, we store the invite and create the staff profile
    } else {
      const { data: member, error: memberErr } = await supabaseAdmin
        .from("business_members")
        .upsert(
          {
            business_id: body.business_id,
            user_id: existingUser.id,
            role,
            is_active: false,
            invited_at: new Date().toISOString(),
          },
          { onConflict: "business_id,user_id" },
        )
        .select("id")
        .single();

      if (memberErr) throw memberErr;
      memberId = member.id;
    }

    // ── INSERT staff_profiles ─────────────────────────────────────────────
    const { data: staffProfile, error: staffErr } = await supabaseAdmin
      .from("staff_profiles")
      .insert({
        business_id: body.business_id,
        business_member_id: memberId,
        display_name: body.display_name,
        specialties: body.specialties ?? [],
        is_active: false, // Activated when invite is accepted
      })
      .select("id")
      .single();

    if (staffErr) throw staffErr;

    // ── Generate magic link for invitation ────────────────────────────────
    const { data: linkData, error: linkErr } =
      await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email: body.email,
      });

    if (linkErr) {
      console.error("Failed to generate magic link:", linkErr);
      // Don't block — we'll still send an email with a fallback URL
    }

    const APP_URL = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";
    const acceptUrl = linkData?.properties?.action_link
      ?? `${APP_URL}/invite?business=${body.business_id}&staff=${staffProfile.id}`;

    // ── Fetch inviter name & business name ────────────────────────────────
    const [inviterResult, businessResult] = await Promise.all([
      supabaseAdmin
        .from("users")
        .select("first_name, last_name")
        .eq("id", user.id)
        .single(),
      supabaseAdmin
        .from("businesses")
        .select("name, locale")
        .eq("id", body.business_id)
        .single(),
    ]);

    const inviterName = inviterResult.data
      ? `${inviterResult.data.first_name ?? ""} ${inviterResult.data.last_name ?? ""}`.trim() || "Your salon"
      : "Your salon";
    const salonName = businessResult.data?.name ?? "the salon";
    const locale = businessResult.data?.locale ?? "en";

    // ── Send invitation email ─────────────────────────────────────────────
    const emailData = staffInviteEmail(
      { salonName, inviterName, acceptUrl },
      locale,
    );

    await sendEmail(body.email, emailData.subject, emailData.html);

    return new Response(
      JSON.stringify({
        invite_sent: true,
        email: body.email,
        staff_profile_id: staffProfile.id,
        member_id: memberId,
      }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("invite-staff error:", err);
    return serverError("Failed to send staff invitation");
  }
}));
