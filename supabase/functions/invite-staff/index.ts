import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, conflict, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
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
    const body: InviteBody = await req.json();

    // ── Validate ──────────────────────────────────────────────────────────
    if (!body.email) return badRequest("email is required");
    if (!EMAIL_RE.test(body.email)) return badRequest("Invalid email address");
    if (!body.display_name) return badRequest("display_name is required");

    const role = body.role ?? "staff";
    if (!["owner", "manager", "staff", "receptionist"].includes(role)) {
      return badRequest("role must be owner, manager, staff, or receptionist");
    }

    // ── Auth: verify JWT + owner/manager membership in one call ──────────
    // business_id is verified against the DB — not blindly trusted from body
    const ctx = await requireOwnerOrManagerCtx(req, body.business_id);
    if (ctx instanceof Response) return ctx;
    const { userId, businessId } = ctx;

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
        .eq("business_id", businessId)
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
      // No user account yet — business_members row is created by accept-staff-invite
      // once the user signs up and accepts. staff_profile is enough to track the invite.
    } else {
      const { data: member, error: memberErr } = await supabaseAdmin
        .from("business_members")
        .upsert(
          {
            business_id: businessId,
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
        business_id: businessId,
        business_member_id: memberId,
        display_name: body.display_name,
        specialties: body.specialties ?? [],
        is_active: false, // Activated when invite is accepted
        invited_email: body.email.toLowerCase(),
      })
      .select("id")
      .single();

    if (staffErr) throw staffErr;

    // ── Fetch inviter name & business name ────────────────────────────────
    // Fetch before building the magic link so country is available for redirectTo.
    const [inviterResult, businessResult] = await Promise.all([
      supabaseAdmin
        .from("users")
        .select("first_name, last_name, email")
        .eq("id", userId)
        .single(),
      supabaseAdmin
        .from("businesses")
        .select("name, locale, country")
        .eq("id", businessId)
        .single(),
    ]);

    const inviterName = inviterResult.data
      ? `${inviterResult.data.first_name ?? ""} ${
        inviterResult.data.last_name ?? ""
      }`.trim() || "Your salon"
      : "Your salon";
    const inviterEmail = inviterResult.data?.email?.trim() || null;
    const salonName = businessResult.data?.name ?? "the salon";
    const locale = businessResult.data?.locale ?? "en";
    const country = (businessResult.data?.country as string | null) ?? "EE";
    const isEstonia = country === "EE";

    // ── Generate magic link for invitation ────────────────────────────────
    // Include staff_profile_id and country in redirectTo so AuthCallbackPage
    // can call accept-staff-invite and show the Estonia FIE gate if needed.
    const APP_URL = Deno.env.get("APP_URL") ?? "https://kazione.app";
    const redirectTo =
      `${APP_URL}/auth/callback?type=staff-invite&staff_profile_id=${staffProfile.id}&country=${encodeURIComponent(country)}`;

    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin
      .generateLink({
        type: "magiclink",
        email: body.email,
        options: { redirectTo },
      });

    if (linkErr) {
      console.error("Failed to generate magic link:", linkErr);
    }

    const acceptUrl = linkData?.properties?.action_link ??
      `${APP_URL}/auth/callback?type=staff-invite&staff_profile_id=${staffProfile.id}`;

    // ── Send invitation email ─────────────────────────────────────────────
    const emailData = staffInviteEmail(
      { salonName, inviterName, acceptUrl, isEstonia },
      locale,
    );

    let inviteSent = true;
    let emailError: string | null = null;
    try {
      if (!Deno.env.get("RESEND_API_KEY")) {
        inviteSent = false;
        emailError = "RESEND_API_KEY is not configured";
      } else {
        await sendEmail(
          body.email,
          emailData.subject,
          emailData.html,
          undefined,
          inviterEmail ? `${inviterName} <${inviterEmail}>` : undefined,
        );
      }
    } catch (err) {
      inviteSent = false;
      emailError = err instanceof Error ? err.message : "Email delivery failed";
      console.error("invite-staff email send failed:", err);
    }

    return new Response(
      JSON.stringify({
        invite_sent: inviteSent,
        email: body.email,
        staff_profile_id: staffProfile.id,
        member_id: memberId,
        email_error: emailError,
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
