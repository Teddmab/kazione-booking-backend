import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx, verifyAuth } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

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
    // business_id derived from JWT — frontend sends no business_id param.
    if (method === "GET") {
      const ctx = await resolveCallerBusiness(req);
      if (ctx instanceof Response) return ctx;

      const { data: staffRows, error: staffErr } = await supabaseAdmin
        .from("staff_profiles")
        .select(`
          id,
          display_name,
          avatar_url,
          is_active,
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

      // Enrich with email + role from business_members → users
      const memberIds = (staffRows ?? [])
        .map((s) => (s as Record<string, unknown>).business_member_id)
        .filter(Boolean) as string[];

      const memberMap = new Map<string, { email: string; role: string }>();
      if (memberIds.length > 0) {
        const { data: members } = await supabaseAdmin
          .from("business_members")
          .select("id, role, users(email)")
          .in("id", memberIds);

        for (const m of members ?? []) {
          const row = m as Record<string, unknown>;
          const usersObj = row.users as { email?: string } | null;
          memberMap.set(row.id as string, {
            email: usersObj?.email ?? "",
            role: row.role as string,
          });
        }
      }

      // Appointment count last 30 days per staff member
      const thirtyDaysAgo = new Date(
        Date.now() - 30 * 24 * 60 * 60 * 1000,
      ).toISOString();
      const staffIds = (staffRows ?? []).map(
        (s) => (s as Record<string, unknown>).id as string,
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

      const result = (staffRows ?? []).map((s) => {
        const row = s as Record<string, unknown>;
        const memberId = row.business_member_id as string | null;
        const memberInfo = memberId ? memberMap.get(memberId) : undefined;
        const workingHours =
          (row.staff_working_hours as Array<Record<string, unknown>>) ?? [];

        return {
          id: row.id,
          display_name: row.display_name,
          email: memberInfo?.email ?? null,
          role: memberInfo?.role ?? "staff",
          is_active: row.is_active,
          avatar_url: row.avatar_url ?? null,
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

    // ── POST /staff (invite new member) ───────────────────────────────────────
    // business_id derived from JWT — frontend sends { name, email, role }.
    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;

      const ctx = await resolveCallerBusiness(req);
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

      // Delegate invite logic entirely to invite-staff
      const { data: inviteData, error: invokeErr } =
        await supabaseAdmin.functions.invoke("invite-staff", {
          body: {
            business_id: ctx.businessId,
            email,
            display_name: name,
            role,
          },
          headers: {
            Authorization: req.headers.get("Authorization") ?? "",
          },
        });

      if (invokeErr) {
        console.error("invite-staff invoke error:", invokeErr);
        return serverError("Failed to invite staff member");
      }

      const invite = inviteData as Record<string, unknown>;

      // Fetch created staff_profile to return consistent shape
      if (invite?.staff_profile_id) {
        const { data: sp } = await supabaseAdmin
          .from("staff_profiles")
          .select("id, display_name, avatar_url, is_active")
          .eq("id", invite.staff_profile_id as string)
          .single();

        if (sp) {
          const profile = sp as Record<string, unknown>;
          return json(
            {
              id: profile.id,
              display_name: profile.display_name,
              email,
              role,
              is_active: profile.is_active,
              avatar_url: profile.avatar_url ?? null,
              working_hours: [],
              appointments_last_30_days: 0,
            },
            201,
          );
        }
      }

      return json(inviteData, 201);
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

      // Return updated row
      const { data: updated, error: fetchErr } = await supabaseAdmin
        .from("staff_profiles")
        .select(`
          id, display_name, bio, avatar_url, specialties,
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
        schedule: (inserted ?? []).map((r) => ({
          day: (r as Record<string, unknown>).day_of_week,
          is_working: (r as Record<string, unknown>).is_working,
          start_time: (r as Record<string, unknown>).start_time ?? null,
          end_time: (r as Record<string, unknown>).end_time ?? null,
        })),
      });
    }

    // ── DELETE /staff?id= (soft deactivate — NEVER hard delete) ───────────────
    if (method === "DELETE") {
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
