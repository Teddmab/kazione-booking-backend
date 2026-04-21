import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const APPT_SELECT = `
  *,
  client:clients!inner(id, first_name, last_name, email, phone, avatar_url),
  service:services!inner(id, name, duration_minutes, price),
  staff:staff_profiles(id, display_name, avatar_url),
  payment:payments(status, amount, method, paid_at)
`;

function normalizePayment(row: Record<string, unknown>) {
  const payment = row.payment as unknown[];
  return { ...row, payment: payment?.[0] ?? null };
}

interface StaffSummaryRow {
  id: string;
  display_name: string;
  role: string;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  specialties: string[];
  status: "Active" | "Off Today" | "Inactive";
  bookings_today: number;
  revenue_today: number;
  utilization_today: number;
}

/**
 * /appointments — appointments CRUD + dashboard KPIs + calendar
 *
 * GET  ?business_id=&[page=&limit=&date_from=&date_to=&status=&staff_id=&search=]
 *      → paginated list
 * GET  ?id=                → single appointment with status log
 * GET  ?action=kpis&business_id=            → getDashboardKPIs
 * GET  ?action=calendar&business_id=&start_date=&end_date=[&staff_id=]
 *      → calendar entries
 * GET  ?action=customer-bookings            → bookings for authenticated customer
 * POST                     → create appointment (body: business_id + fields)
 * PATCH ?id=               → update appointment status (body: status, reason, changed_by)
 */
Deno.serve(withLogging("appointments", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");
  const id = url.searchParams.get("id");

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (method === "GET") {
      // Customer bookings — auth user sees their own appointments
      if (action === "customer-bookings") {
        const user = await verifyAuth(req);

        const { data: clients } = await supabaseAdmin
          .from("clients")
          .select("id")
          .eq("user_id", user.id);

        if (!clients?.length) return json([]);
        const clientIds = (clients as { id: string }[]).map((c) => c.id);

        const { data, error } = await supabaseAdmin
          .from("appointments")
          .select(APPT_SELECT)
          .in("client_id", clientIds)
          .order("starts_at", { ascending: false });

        if (error) return serverError(error.message);
        return json((data ?? []).map(normalizePayment));
      }

      // Single appointment lookup by id (no business_id param required).
      // We infer business_id from the row and then verify membership.
      if (id) {
        const user = await verifyAuth(req);

        const { data: existing, error: existingErr } = await supabaseAdmin
          .from("appointments")
          .select("id, business_id")
          .eq("id", id)
          .maybeSingle();

        if (existingErr) return serverError(existingErr.message);
        if (!existing) return notFound("Appointment not found");

        await verifyBusinessMember(user.id, (existing as { business_id: string }).business_id);

        const { data, error } = await supabaseAdmin
          .from("appointments")
          .select(APPT_SELECT)
          .eq("id", id)
          .single();

        if (error) {
          return error.code === "PGRST116" ? notFound("Appointment not found") : serverError(error.message);
        }

        const { data: statusLog } = await supabaseAdmin
          .from("appointment_status_log")
          .select("*")
          .eq("appointment_id", id)
          .order("created_at", { ascending: true });

        return json({ ...normalizePayment(data), status_log: statusLog ?? [] });
      }

      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      // Verify user is at least a business member for reads
      try {
        const user = await verifyAuth(req);
        await verifyBusinessMember(user.id, businessId);
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }

      if (action === "kpis") {
        const { data, error } = await supabaseAdmin.rpc("get_owner_dashboard_kpis", {
          p_business_id: businessId,
        });
        if (error) return serverError(error.message);
        return json(data);
      }

      if (action === "calendar") {
        const startDate = url.searchParams.get("start_date");
        const endDate = url.searchParams.get("end_date");
        if (!startDate || !endDate) return badRequest("start_date and end_date are required");
        const staffId = url.searchParams.get("staff_id");

        const { data, error } = await supabaseAdmin.rpc("get_business_calendar", {
          p_business_id: businessId,
          p_start_date: startDate,
          p_end_date: endDate,
          p_staff_id: staffId ?? null,
        });
        if (error) return serverError(error.message);
        return json(data ?? []);
      }

      if (action === "staff-summary") {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const [staffResult, apptResult] = await Promise.all([
          supabaseAdmin
            .from("staff_profiles")
            .select(`
              id,
              display_name,
              avatar_url,
              specialties,
              is_active,
              business_member:business_members(role, user:users(email, phone))
            `)
            .eq("business_id", businessId),
          supabaseAdmin
            .from("appointments")
            .select("staff_profile_id, starts_at, ends_at, status, price")
            .eq("business_id", businessId)
            .gte("starts_at", dayStart.toISOString())
            .lt("starts_at", dayEnd.toISOString()),
        ]);

        if (staffResult.error) return serverError(staffResult.error.message);
        if (apptResult.error) return serverError(apptResult.error.message);

        const apptByStaff = new Map<string, Array<Record<string, unknown>>>();
        for (const appt of apptResult.data ?? []) {
          const sid = (appt as { staff_profile_id: string | null }).staff_profile_id;
          if (!sid) continue;
          if (!apptByStaff.has(sid)) apptByStaff.set(sid, []);
          apptByStaff.get(sid)!.push(appt as Record<string, unknown>);
        }

        const rows: StaffSummaryRow[] = (staffResult.data ?? []).map((raw) => {
          const row = raw as Record<string, unknown>;
          const staffId = row.id as string;
          const isActive = Boolean(row.is_active);
          const specialties = Array.isArray(row.specialties)
            ? (row.specialties as string[])
            : [];

          const bm = row.business_member as Record<string, unknown> | null;
          const role = (bm?.role as string | undefined) ?? "staff";
          const user = bm?.user as Record<string, unknown> | null;

          const appts = apptByStaff.get(staffId) ?? [];
          const productive = appts.filter((a) => {
            const status = a.status as string;
            return status !== "cancelled" && status !== "no_show";
          });

          const bookingsToday = productive.length;
          const revenueToday = productive.reduce((sum, a) => sum + Number(a.price ?? 0), 0);
          const utilizedMinutes = productive.reduce((sum, a) => {
            const startsAt = new Date(String(a.starts_at));
            const endsAt = new Date(String(a.ends_at));
            if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return sum;
            return sum + Math.max(0, (endsAt.getTime() - startsAt.getTime()) / 60000);
          }, 0);

          // Baseline workday of 8 hours when working-hours table is not joined.
          const utilizationToday = Math.min(100, Math.round((utilizedMinutes / 480) * 100));

          let status: StaffSummaryRow["status"] = "Inactive";
          if (isActive) {
            status = bookingsToday > 0 ? "Active" : "Off Today";
          }

          return {
            id: staffId,
            display_name: String(row.display_name ?? "Staff"),
            role,
            email: (user?.email as string | undefined) ?? null,
            phone: (user?.phone as string | undefined) ?? null,
            avatar_url: (row.avatar_url as string | undefined) ?? null,
            specialties,
            status,
            bookings_today: bookingsToday,
            revenue_today: Math.round(revenueToday * 100) / 100,
            utilization_today: utilizationToday,
          };
        });

        rows.sort((a, b) => a.display_name.localeCompare(b.display_name));
        return json(rows);
      }

      // Paginated list
      const page = parseInt(url.searchParams.get("page") ?? "1", 10);
      const limit = parseInt(url.searchParams.get("limit") ?? "25", 10);
      const dateFrom = url.searchParams.get("date_from");
      const dateTo = url.searchParams.get("date_to");
      const statusParams = url.searchParams.getAll("status");
      const staffId = url.searchParams.get("staff_id");
      const search = url.searchParams.get("search");

      // deno-lint-ignore no-explicit-any
      let query: any = supabaseAdmin
        .from("appointments")
        .select(APPT_SELECT, { count: "exact" })
        .eq("business_id", businessId)
        .order("starts_at", { ascending: false });

      if (dateFrom) query = query.gte("starts_at", `${dateFrom}T00:00:00`);
      if (dateTo)   query = query.lte("starts_at", `${dateTo}T23:59:59`);
      if (statusParams?.length) query = query.in("status", statusParams);
      if (staffId) query = query.eq("staff_profile_id", staffId);
      if (search) {
        query = query.or(
          `client.first_name.ilike.%${search}%,client.last_name.ilike.%${search}%,client.email.ilike.%${search}%`,
        );
      }

      const from = (page - 1) * limit;
      query = query.range(from, from + limit - 1);

      const { data, error, count } = await query;
      if (error) return serverError(error.message);

      return json({
        appointments: (data ?? []).map(normalizePayment),
        total: count ?? 0,
      });
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
      if (ctx instanceof Response) return ctx;

      const { data: refData, error: refErr } = await supabaseAdmin.rpc("generate_booking_reference");
      if (refErr) return serverError(refErr.message);
      const bookingReference = refData as string;

      const startsAt = body.starts_at as string;
      const durationMinutes = body.duration_minutes as number;
      const endsAt = new Date(
        new Date(startsAt).getTime() + durationMinutes * 60_000,
      ).toISOString();

      const { data: appointment, error } = await supabaseAdmin
        .from("appointments")
        .insert({
          business_id: ctx.businessId,
          client_id: body.client_id,
          service_id: body.service_id,
          staff_profile_id: body.staff_profile_id ?? null,
          starts_at: startsAt,
          ends_at: endsAt,
          duration_minutes: durationMinutes,
          price: body.price,
          deposit_amount: body.deposit_amount ?? 0,
          booking_source: body.booking_source ?? "staff",
          booking_reference: bookingReference,
          is_walk_in: body.is_walk_in ?? false,
          notes: body.notes ?? null,
          internal_notes: body.internal_notes ?? null,
          status: "confirmed",
        })
        .select(`*, client:clients!inner(id, first_name, last_name, email, phone, avatar_url), service:services!inner(id, name, duration_minutes, price), staff:staff_profiles(id, display_name, avatar_url)`)
        .single();

      if (error) return serverError(error.message);

      if ((body.price as number) > 0) {
        await supabaseAdmin.from("payments").insert({
          business_id: ctx.businessId,
          appointment_id: (appointment as Record<string, unknown>).id,
          client_id: body.client_id,
          amount: body.price,
          status: "pending",
          method: "cash",
        });
      }

      await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: (appointment as Record<string, unknown>).id,
        old_status: null,
        new_status: "confirmed",
        reason: "Manual booking created",
      });

      return json({ ...appointment, payment: null }, 201);
    }

    // ── PATCH ──────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;

      // Fetch appointment to get business_id for auth
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("appointments")
        .select("status, business_id")
        .eq("id", id)
        .single();

      if (fetchErr || !existing) return notFound("Appointment not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const status = body.status as string;
      const reason = body.reason as string | undefined;
      const changedBy = body.changed_by as string | undefined;

      const updateFields: Record<string, unknown> = { status };
      if (status === "cancelled") {
        updateFields.cancellation_reason = reason ?? null;
        updateFields.cancelled_at = new Date().toISOString();
        updateFields.cancelled_by = changedBy ?? null;
      }
      if (status === "no_show") {
        updateFields.no_show_marked_at = new Date().toISOString();
      }

      const { data, error } = await supabaseAdmin
        .from("appointments")
        .update(updateFields)
        .eq("id", id)
        .select(APPT_SELECT)
        .single();

      if (error) return serverError(error.message);

      await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: id,
        old_status: (existing as Record<string, unknown>).status,
        new_status: status,
        changed_by: changedBy ?? null,
        reason: reason ?? null,
      });

      return json(normalizePayment(data));
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("appointments error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
