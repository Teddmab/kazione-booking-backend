import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx, verifyAuth } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";
import { sendEmail, staffInviteEmail } from "../_shared/resend.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Resolve the caller's primary owner/manager business from their JWT.
 * Used when the request carries no explicit business_id (e.g. GET /staff).
 */
async function resolveCallerBusiness(
  req: Request,
): Promise<{ userId: string; businessId: string; role: string } | Response> {
  let user;
  try {
    user = await verifyAuth(req);
  } catch (e) {
    return e instanceof Response ? e : forbidden("Authentication required");
  }

  const { data, error } = await supabaseAdmin
    .from("business_members")
    .select("business_id, role")
    .eq("user_id", user.id)
    .eq("is_active", true)
    .in("role", ["owner", "manager"])
    .order("role", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) return serverError(error.message);
  if (!data) return forbidden("No active owner or manager membership found");

  return { userId: user.id, businessId: data.business_id as string, role: data.role as string };
}

Deno.serve(withLogging("staff", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const staffId = url.searchParams.get("id") ?? undefined;
  const action = url.searchParams.get("action") ?? undefined;

  try {
    // ── GET /staff ────────────────────────────────────────────────────────────
    // business_id from query param (preferred) or resolved from JWT membership.
    if (method === "GET" && !action) {
      const qBusinessId = url.searchParams.get("business_id");
      let ctx: { userId: string; businessId: string; role: string } | Response;
      if (qBusinessId) {
        ctx = await requireOwnerOrManagerCtx(req, qBusinessId);
      } else {
        ctx = await resolveCallerBusiness(req);
      }
      if (ctx instanceof Response) return ctx;

      const { data: staffRows, error: staffErr } = await supabaseAdmin
        .from("staff_profiles")
        .select(`
          id,
          display_name,
          position,
          avatar_url,
          is_active,
          invited_email,
          business_member_id,
          staff_working_hours (
            id,
            day_of_week,
            start_time,
            end_time,
            is_working
          )
        `)
        .eq("business_id", ctx.businessId)
        .order("is_active", { ascending: false })
        .order("display_name", { ascending: true });

      if (staffErr) return serverError(staffErr.message);

      // Enrich with email + role + invited_at/joined_at from business_members → users
      const memberIds = (staffRows ?? [])
        .map((s: Record<string, unknown>) => s.business_member_id)
        .filter(Boolean) as string[];

      const memberMap = new Map<
        string,
        { email: string; role: string; invited_at: string | null; joined_at: string | null }
      >();
      if (memberIds.length > 0) {
        const { data: members } = await supabaseAdmin
          .from("business_members")
          .select("id, role, invited_at, joined_at, users(email)")
          .in("id", memberIds);

        for (const m of members ?? []) {
          const row = m as Record<string, unknown>;
          const usersObj = row.users as { email?: string } | null;
          memberMap.set(row.id as string, {
            email: usersObj?.email ?? "",
            role: row.role as string,
            invited_at: (row.invited_at as string | null) ?? null,
            joined_at: (row.joined_at as string | null) ?? null,
          });
        }
      }

      // Appointment count last 30 days per staff member
      const thirtyDaysAgo = new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const staffIds = (staffRows ?? []).map(
        (s: Record<string, unknown>) => s.id as string,
      );

      const apptCountMap = new Map<string, number>();
      if (staffIds.length > 0) {
        const { data: apptRows } = await supabaseAdmin
          .from("appointments")
          .select("staff_profile_id")
          .eq("business_id", ctx.businessId)
          .in("staff_profile_id", staffIds)
          .gte("starts_at", thirtyDaysAgo);

        for (const a of apptRows ?? []) {
          const sid = (a as Record<string, unknown>).staff_profile_id as string;
          apptCountMap.set(sid, (apptCountMap.get(sid) ?? 0) + 1);
        }
      }

      const result = (staffRows ?? []).map((s: Record<string, unknown>) => {
        const row = s;
        const memberId = row.business_member_id as string | null;
        const memberInfo = memberId ? memberMap.get(memberId) : undefined;
        const workingHours =
          (row.staff_working_hours as Array<Record<string, unknown>>) ?? [];

        // Pending invite: invited_email is only set by invite-staff (never by direct POST /staff).
        // It remains set even after activation, so pair it with is_active=false to gate display.
        const invitedAt = memberInfo?.invited_at ?? null;
        const invitedEmail = (row.invited_email as string | null) ?? null;
        const isPendingInvite = !(row.is_active as boolean) && invitedEmail !== null;

        return {
          id: row.id,
          display_name: row.display_name,
          position: (row.position as string | null) ?? null,
          email: memberInfo?.email ?? invitedEmail ?? null,
          role: memberInfo?.role ?? "staff",
          is_active: row.is_active,
          avatar_url: row.avatar_url ?? null,
          invited_at: invitedAt,
          invited_email: invitedEmail,
          is_pending_invite: isPendingInvite,
          working_hours: workingHours.map((wh) => ({
            day: wh.day_of_week,
            is_working: wh.is_working,
            start_time: wh.start_time ?? null,
            end_time: wh.end_time ?? null,
          })),
          appointments_last_30_days:
            apptCountMap.get(row.id as string) ?? 0,
        };
      });

      return json(result);
    }

    // ── POST /staff (add staff member) ───────────────────────────────────────
    // Creates a staff_profile directly. If the email matches an existing user
    // they are also linked via business_members. Staff is active immediately
    // because the owner is adding them explicitly from the dashboard.
    if (method === "POST" && !action) {
      const body = await req.json() as Record<string, unknown>;

      const qBusinessId = body.business_id as string | undefined;
      let ctx: { userId: string; businessId: string; role: string } | Response;
      if (qBusinessId) {
        ctx = await requireOwnerOrManagerCtx(req, qBusinessId);
      } else {
        ctx = await resolveCallerBusiness(req);
      }
      if (ctx instanceof Response) return ctx;

      const name = String(body.name ?? body.display_name ?? "").trim();
      const email = String(body.email ?? "").trim().toLowerCase();
      const role = String(body.role ?? "staff").trim();

      if (!name) return badRequest("name is required");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return badRequest("valid email is required");
      }
      if (!["owner", "manager", "staff", "receptionist"].includes(role)) {
        return badRequest("role must be owner, manager, staff, or receptionist");
      }

      // Link to an existing user account if the email is already registered
      let memberId: string | null = null;
      const { data: existingUser } = await supabaseAdmin
        .from("users")
        .select("id")
        .eq("email", email)
        .maybeSingle();

      if (existingUser) {
        // Check for an existing membership (active or inactive)
        const { data: existingMember } = await supabaseAdmin
          .from("business_members")
          .select("id, is_active")
          .eq("business_id", ctx.businessId)
          .eq("user_id", existingUser.id)
          .maybeSingle();

        if (existingMember?.is_active) {
          // Already an active member — still create a staff profile if they
          // don't have one yet (e.g. owner adding themselves as bookable staff)
          memberId = existingMember.id as string;
        } else {
          // Create or re-activate the membership
          const { data: member, error: memberErr } = await supabaseAdmin
            .from("business_members")
            .upsert(
              {
                business_id: ctx.businessId,
                user_id: existingUser.id,
                role,
                is_active: true,
                invited_at: new Date().toISOString(),
              },
              { onConflict: "business_id,user_id" },
            )
            .select("id")
            .single();
          if (memberErr) return serverError(memberErr.message);
          memberId = member.id as string;
        }
      }

      const position = String(body.position ?? "").trim() || null;

      // Create the staff profile (active immediately — owner is adding them)
      const { data: staffProfile, error: staffErr } = await supabaseAdmin
        .from("staff_profiles")
        .insert({
          business_id: ctx.businessId,
          business_member_id: memberId,
          display_name: name,
          position,
          is_active: true,
        })
        .select("id, display_name, position, avatar_url, is_active")
        .single();

      if (staffErr) return serverError(staffErr.message);

      const sp = staffProfile as Record<string, unknown>;
      return json(
        {
          id: sp.id,
          display_name: sp.display_name,
          position: sp.position ?? null,
          email,
          role,
          is_active: sp.is_active,
          avatar_url: sp.avatar_url ?? null,
          working_hours: [],
          appointments_last_30_days: 0,
        },
        201,
      );
    }

    // ── PATCH /staff?action=assign-services&id= (set service assignments) ───────
    // Accepts { service_ids: string[] } — replaces ALL existing staff_services rows.
    if (method === "PATCH" && action === "assign-services") {
      if (!staffId) return badRequest("id query param is required");
      const body = await req.json() as Record<string, unknown>;
      const serviceIds = body.service_ids as string[] | undefined;
      if (!Array.isArray(serviceIds)) return badRequest("service_ids must be an array");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id")
        .eq("id", staffId)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff member not found");

      const ctx = await requireOwnerOrManagerCtx(
        req,
        (existing as Record<string, unknown>).business_id as string,
      );
      if (ctx instanceof Response) return ctx;

      // Verify all service_ids belong to this business (active or inactive — owner decides)
      if (serviceIds.length > 0) {
        const { data: validSvcs, error: svcErr } = await supabaseAdmin
          .from("services")
          .select("id")
          .in("id", serviceIds)
          .eq("business_id", ctx.businessId);

        if (svcErr) return serverError(svcErr.message);
        if ((validSvcs ?? []).length !== serviceIds.length) {
          return badRequest("One or more service_ids do not belong to this business");
        }
      }

      // Full replace: delete existing assignments then insert new ones
      const { error: delErr } = await supabaseAdmin
        .from("staff_services")
        .delete()
        .eq("staff_profile_id", staffId);
      if (delErr) return serverError(delErr.message);

      if (serviceIds.length > 0) {
        const rows = serviceIds.map((sid) => ({
          staff_profile_id: staffId,
          service_id: sid,
        }));
        const { error: insErr } = await supabaseAdmin
          .from("staff_services")
          .insert(rows);
        if (insErr) return serverError(insErr.message);
      }

      return json({ success: true, service_ids: serviceIds });
    }

    // ── GET /staff?action=services&id= (get current service assignments) ────────
    if (method === "GET" && action === "services") {
      if (!staffId) return badRequest("id query param is required");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id")
        .eq("id", staffId)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff member not found");

      // Verify caller owns/manages the same business as this staff profile
      const ctx = await requireOwnerOrManagerCtx(
        req,
        (existing as Record<string, unknown>).business_id as string,
      );
      if (ctx instanceof Response) return ctx;

      const { data: rows, error: svcErr } = await supabaseAdmin
        .from("staff_services")
        .select("service_id")
        .eq("staff_profile_id", staffId);

      if (svcErr) return serverError(svcErr.message);

      return json({ service_ids: (rows ?? []).map((r: Record<string, unknown>) => r.service_id) });
    }

    // ── PATCH /staff?action=resend-invite&id= (resend invitation email) ─────────
    // Re-generates the magic link and resends the email without creating new rows.
    if (method === "PATCH" && action === "resend-invite") {
      if (!staffId) return badRequest("id query param is required");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id, business_member_id, display_name, invited_email, is_active")
        .eq("id", staffId)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff member not found");

      const sp = existing as Record<string, unknown>;

      if (sp.is_active) {
        return badRequest("Staff member is already active — no pending invitation to resend");
      }

      const ctx = await requireOwnerOrManagerCtx(req, sp.business_id as string);
      if (ctx instanceof Response) return ctx;

      // Resolve the email to send to
      let toEmail: string | null = sp.invited_email as string | null;
      if (!toEmail && sp.business_member_id) {
        const { data: memberRow } = await supabaseAdmin
          .from("business_members")
          .select("users(email)")
          .eq("id", sp.business_member_id as string)
          .single();
        const usersObj = (memberRow as Record<string, unknown> | null)?.users as { email?: string } | null;
        toEmail = usersObj?.email ?? null;
      }

      if (!toEmail) {
        return badRequest("No email found for this invitation — cannot resend");
      }

      // Update invited_at timestamp and reset join state
      if (sp.business_member_id) {
        await supabaseAdmin
          .from("business_members")
          .update({ invited_at: new Date().toISOString() })
          .eq("id", sp.business_member_id as string);
      }

      // Fetch business info + caller name for the email
      const [inviterResult, businessResult] = await Promise.all([
        supabaseAdmin
          .from("users")
          .select("first_name, last_name, email")
          .eq("id", ctx.userId)
          .single(),
        supabaseAdmin
          .from("businesses")
          .select("name, locale")
          .eq("id", sp.business_id as string)
          .single(),
      ]);

      const inviterName = inviterResult.data
        ? `${inviterResult.data.first_name ?? ""} ${inviterResult.data.last_name ?? ""}`.trim() || "Your salon"
        : "Your salon";
      const inviterEmail = inviterResult.data?.email?.trim() || null;
      const salonName = businessResult.data?.name ?? "the salon";
      const locale = businessResult.data?.locale ?? "en";

      // Generate a fresh magic link with redirectTo so the callback can activate the member
      const APP_URL = Deno.env.get("APP_URL") ?? "https://kazione.app";
      const redirectTo =
        `${APP_URL}/auth/callback?type=staff-invite&staff_profile_id=${staffId}`;
      const { data: linkData } = await supabaseAdmin.auth.admin.generateLink({
        type: "magiclink",
        email: toEmail,
        options: { redirectTo },
      });
      const acceptUrl = linkData?.properties?.action_link ??
        `${APP_URL}/auth/callback?type=staff-invite&staff_profile_id=${staffId}`;

      // Send the email via the shared helper
      const emailData = staffInviteEmail({ salonName, inviterName, acceptUrl }, locale);

      let inviteSent = true;
      let emailError: string | null = null;
      try {
        if (!Deno.env.get("RESEND_API_KEY")) {
          inviteSent = false;
          emailError = "RESEND_API_KEY is not configured";
        } else {
          await sendEmail(
            toEmail,
            emailData.subject,
            emailData.html,
            undefined,
            inviterEmail ? `${inviterName} <${inviterEmail}>` : undefined,
          );
        }
      } catch (err) {
        inviteSent = false;
        emailError = err instanceof Error ? err.message : "Email delivery failed";
        console.error("staff resend-invite email failed:", err);
      }

      return json({ invite_sent: inviteSent, email: toEmail, email_error: emailError });
    }

    // ── PATCH /staff?id= (update profile / role) ──────────────────────────────
    // business_id comes from the staff record in DB — never trusted from body.
    if (method === "PATCH") {
      if (!staffId) return badRequest("id query param is required");
      const body = await req.json() as Record<string, unknown>;

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id, business_member_id")
        .eq("id", staffId)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff member not found");

      // Auth: verify caller is owner/manager of the staff member's business
      const ctx = await requireOwnerOrManagerCtx(
        req,
        (existing as Record<string, unknown>).business_id as string,
      );
      if (ctx instanceof Response) return ctx;

      const profileUpdate: Record<string, unknown> = {};
      if (body.display_name !== undefined) {
        const dn = String(body.display_name).trim();
        if (!dn) return badRequest("display_name cannot be empty");
        profileUpdate.display_name = dn;
      }
      if (body.position !== undefined) {
        profileUpdate.position = String(body.position ?? "").trim() || null;
      }
      if (body.bio !== undefined) {
        profileUpdate.bio = String(body.bio ?? "").trim() || null;
      }
      if (body.avatar_url !== undefined) {
        profileUpdate.avatar_url = String(body.avatar_url ?? "").trim() || null;
      }
      if (body.is_active !== undefined) {
        profileUpdate.is_active = Boolean(body.is_active);
      }
      if (body.calendar_color !== undefined) {
        profileUpdate.calendar_color = String(body.calendar_color);
      }

      const newRole = body.role as string | undefined;
      if (Object.keys(profileUpdate).length === 0 && !newRole) {
        return badRequest("No updatable fields provided");
      }

      if (Object.keys(profileUpdate).length > 0) {
        const { error: updateErr } = await supabaseAdmin
          .from("staff_profiles")
          .update(profileUpdate)
          .eq("id", staffId)
          .eq("business_id", ctx.businessId);
        if (updateErr) return serverError(updateErr.message);
      }

      // Update role in business_members if provided
      const memberId = (existing as Record<string, unknown>)
        .business_member_id as string | null;
      if (newRole && memberId) {
        if (!["owner", "manager", "staff", "receptionist"].includes(newRole)) {
          return badRequest(
            "role must be one of: owner, manager, staff, receptionist",
          );
        }
        await supabaseAdmin
          .from("business_members")
          .update({ role: newRole })
          .eq("id", memberId)
          .eq("business_id", ctx.businessId);
      }

      // Sync is_active to business_members — needed for manual owner activation
      // from the dashboard (staff_profiles.is_active alone is not enough to grant login access)
      const newIsActive = profileUpdate.is_active as boolean | undefined;
      if (newIsActive !== undefined && memberId) {
        await supabaseAdmin
          .from("business_members")
          .update({ is_active: newIsActive })
          .eq("id", memberId);
      }

      // Return updated row
      const { data: updated, error: fetchErr } = await supabaseAdmin
        .from("staff_profiles")
        .select(`
          id, display_name, position, bio, avatar_url, specialties,
          calendar_color, is_active, created_at,
          business_member:business_members(id, role, users(email))
        `)
        .eq("id", staffId)
        .single();

      if (fetchErr) return serverError(fetchErr.message);
      return json(updated);
    }

    // ── PUT /staff?action=schedule&id= (set working hours) ────────────────────
    // Accepts the schedule array as the request body directly (no wrapper object).
    if (method === "PUT" && action === "schedule") {
      if (!staffId) return badRequest("id query param is required");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id")
        .eq("id", staffId)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff member not found");

      const ctx = await requireOwnerOrManagerCtx(
        req,
        (existing as Record<string, unknown>).business_id as string,
      );
      if (ctx instanceof Response) return ctx;

      const rawBody = await req.json();

      // Accept both a plain array and { schedule: [...] }
      const scheduleArr: unknown[] = Array.isArray(rawBody)
        ? rawBody
        : Array.isArray((rawBody as Record<string, unknown>).schedule)
          ? (rawBody as Record<string, unknown>).schedule as unknown[]
          : null!;

      if (!Array.isArray(scheduleArr)) {
        return badRequest("Body must be an array of working-day objects");
      }

      for (const entry of scheduleArr as Record<string, unknown>[]) {
        const day = Number(entry.day_of_week ?? entry.day);
        if (!Number.isInteger(day) || day < 0 || day > 6) {
          return badRequest(`day_of_week must be 0–6, got: ${entry.day_of_week ?? entry.day}`);
        }
        if (entry.is_working) {
          if (!entry.start_time || !entry.end_time) {
            return badRequest(
              `start_time and end_time required when is_working=true (day ${day})`,
            );
          }
          if (String(entry.start_time) >= String(entry.end_time)) {
            return badRequest(`start_time must be before end_time (day ${day})`);
          }
        }
      }

      // Full replace
      const { error: deleteErr } = await supabaseAdmin
        .from("staff_working_hours")
        .delete()
        .eq("staff_profile_id", staffId);
      if (deleteErr) return serverError(deleteErr.message);

      const rows = (scheduleArr as Record<string, unknown>[]).map((e) => {
        const day = Number(e.day_of_week ?? e.day);
        const isWorking = Boolean(e.is_working);
        return {
          staff_profile_id: staffId,
          business_id: ctx.businessId,
          day_of_week: day,
          is_working: isWorking,
          start_time: isWorking ? (e.start_time as string) : null,
          end_time: isWorking ? (e.end_time as string) : null,
        };
      });

      const { data: inserted, error: insertErr } = await supabaseAdmin
        .from("staff_working_hours")
        .insert(rows)
        .select("id, day_of_week, is_working, start_time, end_time");
      if (insertErr) return serverError(insertErr.message);

      return json({
        success: true,
        schedule: (inserted ?? []).map((r: Record<string, unknown>) => ({
          day: r.day_of_week,
          is_working: r.is_working,
          start_time: r.start_time ?? null,
          end_time: r.end_time ?? null,
        })),
      });
    }

    // ── GET /staff?action=overrides&id= ──────────────────────────────────────
    // Returns schedule overrides for a staff member within a date range.
    // Query params: from (YYYY-MM-DD), to (YYYY-MM-DD)
    if (method === "GET" && action === "overrides") {
      if (!staffId) return badRequest("id query param is required");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id")
        .eq("id", staffId)
        .maybeSingle();
      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff member not found");

      const ctx = await requireOwnerOrManagerCtx(
        req,
        (existing as Record<string, unknown>).business_id as string,
      );
      if (ctx instanceof Response) return ctx;

      const fromDate = url.searchParams.get("from");
      const toDate = url.searchParams.get("to");

      let query = supabaseAdmin
        .from("staff_schedule_overrides")
        .select("id, override_date, is_working, start_time, end_time, reason, created_at")
        .eq("staff_profile_id", staffId)
        .order("override_date", { ascending: true });

      if (fromDate) query = query.gte("override_date", fromDate);
      if (toDate) query = query.lte("override_date", toDate);

      const { data: overrides, error: overridesErr } = await query;
      if (overridesErr) return serverError(overridesErr.message);
      return json(overrides ?? []);
    }

    // ── POST /staff?action=override&id= ──────────────────────────────────────
    // Upserts a schedule override for a specific date.
    // Body: { date: "YYYY-MM-DD", is_working: bool, start_time?: "HH:MM", end_time?: "HH:MM", reason?: string }
    if (method === "POST" && action === "override") {
      if (!staffId) return badRequest("id query param is required");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id")
        .eq("id", staffId)
        .maybeSingle();
      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff member not found");

      const ctx = await requireOwnerOrManagerCtx(
        req,
        (existing as Record<string, unknown>).business_id as string,
      );
      if (ctx instanceof Response) return ctx;

      const body = await req.json() as Record<string, unknown>;
      const overrideDate = String(body.date ?? "").trim();
      const isWorking = Boolean(body.is_working ?? true);
      const startTime = body.start_time ? String(body.start_time).trim() : null;
      const endTime = body.end_time ? String(body.end_time).trim() : null;
      const reason = body.reason ? String(body.reason).trim() : null;

      if (!overrideDate || !/^\d{4}-\d{2}-\d{2}$/.test(overrideDate)) {
        return badRequest("date must be YYYY-MM-DD");
      }
      if (isWorking && (!startTime || !endTime)) {
        return badRequest("start_time and end_time required when is_working = true");
      }
      if (isWorking && startTime! >= endTime!) {
        return badRequest("start_time must be before end_time");
      }

      const { data: upserted, error: upsertErr } = await supabaseAdmin
        .from("staff_schedule_overrides")
        .upsert(
          {
            staff_profile_id: staffId,
            business_id: ctx.businessId,
            override_date: overrideDate,
            is_working: isWorking,
            start_time: isWorking ? startTime : null,
            end_time: isWorking ? endTime : null,
            reason,
          },
          { onConflict: "staff_profile_id,override_date" },
        )
        .select("id, override_date, is_working, start_time, end_time, reason")
        .single();

      if (upsertErr) return serverError(upsertErr.message);
      return json(upserted, 201);
    }

    // ── DELETE /staff?action=override&id=&date= ───────────────────────────────
    // Removes a schedule override for a specific date.
    if (method === "DELETE" && action === "override") {
      if (!staffId) return badRequest("id query param is required");
      const overrideDate = url.searchParams.get("date");
      if (!overrideDate) return badRequest("date query param is required");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id")
        .eq("id", staffId)
        .maybeSingle();
      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff member not found");

      const ctx = await requireOwnerOrManagerCtx(
        req,
        (existing as Record<string, unknown>).business_id as string,
      );
      if (ctx instanceof Response) return ctx;

      const { error: delErr } = await supabaseAdmin
        .from("staff_schedule_overrides")
        .delete()
        .eq("staff_profile_id", staffId)
        .eq("business_id", ctx.businessId)
        .eq("override_date", overrideDate);

      if (delErr) return serverError(delErr.message);
      return json({ success: true });
    }

    // ── DELETE /staff?action=cancel-invite&id= ───────────────────────────────
    // Hard-delete a pending (never-accepted) staff invite. Safe to hard-delete
    // because the invite was never activated — no user account is linked yet.
    if (method === "DELETE" && action === "cancel-invite") {
      if (!staffId) return badRequest("id query param is required");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id, business_member_id, is_active")
        .eq("id", staffId)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff invitation not found");

      const sp = existing as Record<string, unknown>;
      if (sp.is_active) {
        return badRequest("Cannot cancel-invite on an active staff member. Use the deactivate action instead.");
      }

      const ctx = await requireOwnerOrManagerCtx(req, sp.business_id as string);
      if (ctx instanceof Response) return ctx;

      // Delete the staff_profiles row
      const { error: deleteProfileErr } = await supabaseAdmin
        .from("staff_profiles")
        .delete()
        .eq("id", staffId)
        .eq("business_id", ctx.businessId);
      if (deleteProfileErr) return serverError(deleteProfileErr.message);

      // Delete the business_members row if one was created
      const memberId = sp.business_member_id as string | null;
      if (memberId) {
        await supabaseAdmin
          .from("business_members")
          .delete()
          .eq("id", memberId);
      }

      return json({ success: true });
    }

    // ── DELETE /staff?id= (soft deactivate — NEVER hard delete) ───────────────
    if (method === "DELETE" && !action) {
      if (!staffId) return badRequest("id query param is required");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("staff_profiles")
        .select("id, business_id, business_member_id")
        .eq("id", staffId)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Staff member not found");

      const ctx = await requireOwnerOrManagerCtx(
        req,
        (existing as Record<string, unknown>).business_id as string,
      );
      if (ctx instanceof Response) return ctx;

      const { error: deactivateErr } = await supabaseAdmin
        .from("staff_profiles")
        .update({ is_active: false })
        .eq("id", staffId)
        .eq("business_id", ctx.businessId);
      if (deactivateErr) return serverError(deactivateErr.message);

      // Also deactivate the business membership so they lose dashboard access
      const memberId = (existing as Record<string, unknown>)
        .business_member_id as string | null;
      if (memberId) {
        await supabaseAdmin
          .from("business_members")
          .update({ is_active: false })
          .eq("id", memberId);
      }

      return json({ success: true });
    }

    return badRequest(`Method ${method} is not supported`);
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[staff] Unhandled error:", err);
    return serverError(
      err instanceof Error ? err.message : "Internal server error",
    );
  }
}));
