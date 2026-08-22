import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, conflict, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";
import { isSlotTakenError } from "../_shared/slotConflict.ts";
import {
  bookingCancellationEmail,
  bookingReceivedOwnerEmail,
  bookingRescheduleEmail,
  staffBookingCancellationEmail,
  staffNewBookingEmail,
  staffAppointmentOfferEmail,
  ownerPendingCompletionEmail,
  staffCompletionConfirmedEmail,
  reviewRequestEmail,
  bookingConfirmationEmail,
  sendEmail,
} from "../_shared/resend.ts";
import { generateIcs, icsToBase64, googleCalendarUrl } from "../_shared/ics.ts";
import { localWallClockToUtcIso, utcIsoToLocalParts } from "../_shared/timezone.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const APPT_SELECT = `
  *,
  client:clients!inner(id, first_name, last_name, email, phone, avatar_url),
  service:services!inner(id, name, duration_minutes, price, staff_commission_type, staff_commission_value, requires_two_staff, commission_split_pct, service_product_usage(quantity_per_service, product:product_catalog(unit_cost))),
  staff:staff_profiles!staff_profile_id(id, display_name, avatar_url, commission_rate),
  staff2:staff_profiles!staff_profile_id_2(id, display_name, avatar_url, commission_rate),
  referrer_staff:staff_profiles!referrer_staff_id(id, display_name, avatar_url),
  payment:payments(status, amount, method, paid_at),
  applied_offer:offer_redemptions!offer_redemption_id(id, status, offer:business_offers(id, type, title, discount_type, discount_value)),
  business:businesses(name, timezone)
`;

function normalizePayment(row: Record<string, unknown>) {
  const payment = row.payment as unknown[];
  return { ...row, payment: payment?.[0] ?? null };
}

async function fetchStaffEmail(staffProfileId: string): Promise<string | null> {
  const { data: sp } = await supabaseAdmin
    .from("staff_profiles")
    .select("business_member_id")
    .eq("id", staffProfileId)
    .maybeSingle();
  const memberId = (sp as Record<string, unknown> | null)?.business_member_id as string | null;
  if (!memberId) return null;
  const { data: bm } = await supabaseAdmin
    .from("business_members")
    .select("user:users(email)")
    .eq("id", memberId)
    .maybeSingle();
  const u = (bm as Record<string, unknown> | null)?.user as Record<string, unknown> | null;
  return (u?.email as string | null) ?? null;
}

async function fetchOwnerEmail(businessId: string): Promise<string | null> {
  const { data: ownerMember } = await supabaseAdmin
    .from("business_members")
    .select("user:users(email)")
    .eq("business_id", businessId)
    .eq("role", "owner")
    .eq("is_active", true)
    .maybeSingle();
  const u = (ownerMember as Record<string, unknown> | null)?.user as Record<string, unknown> | null;
  return (u?.email as string | null) ?? null;
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

        if (!clients?.length) return jsonCors(req, []);
        const clientIds = (clients as { id: string }[]).map((c) => c.id);

        const { data, error } = await supabaseAdmin
          .from("appointments")
          .select(APPT_SELECT)
          .in("client_id", clientIds)
          .is("deleted_at", null)
          .order("starts_at", { ascending: false });

        if (error) return serverError(error.message);
        return jsonCors(req, (data ?? []).map(normalizePayment));
      }

      // Single appointment lookup by id (no business_id param required).
      // We infer business_id from the row and then verify membership.
      if (id) {
        const user = await verifyAuth(req);

        const { data: existing, error: existingErr } = await supabaseAdmin
          .from("appointments")
          .select("id, business_id")
          .eq("id", id)
          .is("deleted_at", null)
          .maybeSingle();

        if (existingErr) return serverError(existingErr.message);
        if (!existing) return notFound("Appointment not found");

        await verifyBusinessMember(user.id, (existing as { business_id: string }).business_id);

        const { data, error } = await supabaseAdmin
          .from("appointments")
          .select(APPT_SELECT)
          .eq("id", id)
          .is("deleted_at", null)
          .single();

        if (error) {
          return error.code === "PGRST116" ? notFound("Appointment not found") : serverError(error.message);
        }

        const { data: statusLog } = await supabaseAdmin
          .from("appointment_status_log")
          .select("*")
          .eq("appointment_id", id)
          .order("created_at", { ascending: true });

        return jsonCors(req, { ...normalizePayment(data), status_log: statusLog ?? [] });
      }

      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      // Verify user is at least a business member for reads.
      // If the caller is a staff member, capture their staff_profile_id
      // so we can filter the appointment list to only their assignments.
      let callerStaffProfileId: string | null = null;
      try {
        const user = await verifyAuth(req);
        const { data: memberRow, error: memberErr } = await supabaseAdmin
          .from("business_members")
          .select("id, role")
          .eq("user_id", user.id)
          .eq("business_id", businessId)
          .eq("is_active", true)
          .maybeSingle();
        if (memberErr || !memberRow) {
          return new Response(
            JSON.stringify({ error: { code: "FORBIDDEN", message: "Not a member of this business" } }),
            { status: 403, headers: { ...corsHeadersFor(req), "Content-Type": "application/json" } },
          );
        }
        const callerRole = (memberRow as { id: string; role: string }).role;
        if (callerRole === "staff") {
          const { data: sp } = await supabaseAdmin
            .from("staff_profiles")
            .select("id")
            .eq("business_member_id", (memberRow as { id: string }).id)
            .eq("business_id", businessId)
            .maybeSingle();
          callerStaffProfileId = (sp as { id: string } | null)?.id ?? null;
        }
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }

      if (action === "kpis") {
        const { data, error } = await supabaseAdmin.rpc("get_owner_dashboard_kpis", {
          p_business_id: businessId,
        });
        if (error) return serverError(error.message);
        return jsonCors(req, data);
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
        return jsonCors(req, data ?? []);
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
            .is("deleted_at", null)
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
        return jsonCors(req, rows);
      }

      // Paginated list
      const page = parseInt(url.searchParams.get("page") ?? "1", 10);
      const limit = parseInt(url.searchParams.get("limit") ?? "25", 10);
      const dateFrom = url.searchParams.get("date_from");
      const dateTo = url.searchParams.get("date_to");
      const statusParams = url.searchParams.getAll("status");
      const staffId = url.searchParams.get("staff_id");
      const serviceId = url.searchParams.get("service_id");
      const search = url.searchParams.get("search");

      // deno-lint-ignore no-explicit-any
      let query: any = supabaseAdmin
        .from("appointments")
        .select(APPT_SELECT, { count: "exact" })
        .eq("business_id", businessId)
        .is("deleted_at", null)
        .order("starts_at", { ascending: false });

      if (dateFrom) query = query.gte("starts_at", `${dateFrom}T00:00:00`);
      if (dateTo)   query = query.lte("starts_at", `${dateTo}T23:59:59`);
      if (statusParams?.length) query = query.in("status", statusParams);
      // Staff callers: restrict to their own appointments (primary or secondary role)
      // Owner/manager: respect optional staffId param
      if (callerStaffProfileId) {
        query = query.or(
          `staff_profile_id.eq.${callerStaffProfileId},staff_profile_id_2.eq.${callerStaffProfileId}`,
        );
      } else if (staffId) {
        query = query.eq("staff_profile_id", staffId);
      }
      if (serviceId) query = query.eq("service_id", serviceId);
      if (search) {
        query = query.or(
          `client.first_name.ilike.%${search}%,client.last_name.ilike.%${search}%,client.email.ilike.%${search}%`,
        );
      }

      const from = (page - 1) * limit;
      query = query.range(from, from + limit - 1);

      const { data, error, count } = await query;
      if (error) return serverError(error.message);

      const appointments = (data ?? []).map((row: Record<string, unknown>) => {
        const normalized = normalizePayment(row as Record<string, unknown>);
        if (!callerStaffProfileId) return normalized;

        // Calculate commission_earned for staff view
        const rowData = row as Record<string, unknown>;
        const svc = rowData.service as Record<string, unknown> | null;
        const staffRow = rowData.staff as Record<string, unknown> | null;
        const staff2Row = rowData.staff2 as Record<string, unknown> | null;
        const price = Number(rowData.price ?? 0);
        const commType = (svc?.staff_commission_type as string) ?? "none";
        const commValue = Number(svc?.staff_commission_value ?? 0);
        const staffRate = Number(staffRow?.commission_rate ?? 0);
        const staff2Rate = Number(staff2Row?.commission_rate ?? staffRate);
        const splitPct = Number(rowData.commission_split_pct ?? 100);
        const isPrimary = rowData.staff_profile_id === callerStaffProfileId;
        const myRate = isPrimary ? staffRate : staff2Rate;
        // Fraction of total commission this caller earns
        const myFraction = isPrimary ? splitPct / 100 : (100 - splitPct) / 100;

        let commissionEarned: number | null = null;
        if (commType === "percentage" && commValue > 0) {
          commissionEarned = Math.round(price * commValue / 100 * myFraction * 100) / 100;
        } else if (commType === "fixed" && commValue > 0) {
          commissionEarned = Math.round(commValue * myFraction * 100) / 100;
        } else if (myRate > 0) {
          commissionEarned = Math.round(price * myRate / 100 * myFraction * 100) / 100;
        }

        return { ...normalized, commission_earned: commissionEarned };
      });

      return jsonCors(req, { appointments, total: count ?? 0 });
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
      if (ctx instanceof Response) return ctx;

      const { data: refData, error: refErr } = await supabaseAdmin.rpc("generate_booking_reference");
      if (refErr) return serverError(refErr.message);
      const bookingReference = refData as string;

      // date+time are the business's local wall-clock (matching create-booking's
      // contract — S59) rather than a pre-combined starts_at string, which had
      // no way to express "this is local, convert me" and only worked because
      // Deno/Postgres default to UTC.
      const dateStr = body.date as string | undefined;
      const timeStr = body.time as string | undefined;
      if (!dateStr || !DATE_RE.test(dateStr)) return badRequest("date is required (YYYY-MM-DD)");
      if (!timeStr || !TIME_RE.test(timeStr)) return badRequest("time is required (HH:MM)");
      const durationMinutes = body.duration_minutes as number;

      // Buffer minutes for the target service — needed by
      // check_and_reserve_slot (called inside create_manual_appointment_atomic)
      // to compute the same overlap window create-booking's online path uses.
      const [svcBufferResult, bizTzResult] = await Promise.all([
        supabaseAdmin
          .from("services")
          .select("buffer_minutes")
          .eq("id", body.service_id as string)
          .eq("business_id", ctx.businessId)
          .maybeSingle(),
        supabaseAdmin
          .from("businesses")
          .select("timezone")
          .eq("id", ctx.businessId)
          .maybeSingle(),
      ]);
      if (svcBufferResult.error) return serverError(svcBufferResult.error.message);
      if (!svcBufferResult.data) return badRequest("service_id does not belong to this business");
      if (bizTzResult.error) return serverError(bizTzResult.error.message);
      const svcForBuffer = svcBufferResult.data;

      const startsAt = localWallClockToUtcIso(dateStr, timeStr, bizTzResult.data?.timezone ?? "UTC");
      const endsAt = new Date(
        new Date(startsAt).getTime() + durationMinutes * 60_000,
      ).toISOString();

      // Atomic: advisory-lock + buffer-aware conflict check + insert, all in
      // one transaction (S58) — a raw .insert() here would let the owner
      // dashboard silently double-book a staff member under concurrent
      // requests, the same race the online booking flow already guards
      // against via create_booking_atomic.
      const { data: newApptId, error: atomicErr } = await supabaseAdmin.rpc(
        "create_manual_appointment_atomic",
        {
          p_business_id: ctx.businessId,
          p_client_id: body.client_id,
          p_service_id: body.service_id,
          p_staff_id: body.staff_profile_id ?? null,
          p_starts_at: startsAt,
          p_ends_at: endsAt,
          p_duration_minutes: durationMinutes,
          p_buffer_minutes: (svcForBuffer as { buffer_minutes: number | null }).buffer_minutes ?? 0,
          p_price: body.price,
          p_deposit_amount: body.deposit_amount ?? 0,
          p_booking_source: body.booking_source ?? "staff",
          p_booking_reference: bookingReference,
          p_is_walk_in: body.is_walk_in ?? false,
          p_notes: body.notes ?? null,
          p_internal_notes: body.internal_notes ?? null,
          p_status: body.staff_profile_id ? "confirmed" : "pending",
        },
      );

      if (atomicErr) {
        if (isSlotTakenError(atomicErr)) {
          return conflict("SLOT_TAKEN", "This staff member already has a conflicting appointment at that time");
        }
        console.error("create_manual_appointment_atomic error:", JSON.stringify(atomicErr));
        return serverError(atomicErr.message);
      }

      const { data: appointment, error } = await supabaseAdmin
        .from("appointments")
        .select(`*, client:clients!inner(id, first_name, last_name, email, phone, avatar_url), service:services!inner(id, name, duration_minutes, price, staff_commission_type, staff_commission_value, service_product_usage(quantity_per_service, product:product_catalog(unit_cost))), staff:staff_profiles!staff_profile_id(id, display_name, avatar_url)`)
        .eq("id", newApptId as string)
        .single();

      if (error) return serverError(error.message);

      const apptId = (appointment as Record<string, unknown>).id as string;
      const initialStatus = body.staff_profile_id ? "confirmed" : "pending";

      if ((body.price as number) > 0) {
        await supabaseAdmin.from("payments").insert({
          business_id: ctx.businessId,
          appointment_id: apptId,
          client_id: body.client_id,
          amount: body.price,
          status: "pending",
          method: "cash",
        });
      }

      await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: apptId,
        old_status: null,
        new_status: initialStatus,
        reason: body.staff_profile_id ? "Manual booking created" : "Booking created — awaiting staff assignment",
      });

      // Notifications — fire & forget
      {
        const [notifSettingsRes, notifBizRes] = await Promise.all([
          supabaseAdmin.from("business_settings").select("booking_notification_email").eq("business_id", ctx.businessId).maybeSingle(),
          supabaseAdmin.from("businesses").select("name, logo_url, currency_code, timezone").eq("id", ctx.businessId).single(),
        ]);
        const biz = notifBizRes.data;
        const appt = appointment as Record<string, unknown>;
        const clientRow = appt.client as Record<string, unknown>;
        const serviceRow = appt.service as Record<string, unknown>;
        const staffRow = appt.staff as Record<string, unknown> | null;
        const localParts = utcIsoToLocalParts(startsAt, biz?.timezone ?? "UTC");
        const d = new Date(localParts.date + "T00:00:00Z");
        const formattedDate = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
        const formattedTime = localParts.time;
        const currencyCode = biz?.currency_code ?? "EUR";
        const priceDisplay = `${currencyCode === "EUR" ? "€" : currencyCode} ${(body.price as number).toFixed(2)}`;
        const appUrl = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";
        const clientName = `${clientRow.first_name ?? ""} ${clientRow.last_name ?? ""}`.trim() || "Client";
        const salonName = biz?.name ?? "";
        const serviceName = serviceRow.name as string;
        const staffDisplayName = (staffRow?.display_name as string | null) ?? "TBD";

        // Owner notification
        const ownerNotifEmail = notifSettingsRes.data?.booking_notification_email as string | null | undefined;
        if (ownerNotifEmail) {
          const ownerEmailData = bookingReceivedOwnerEmail({
            clientName,
            clientEmail: (clientRow.email as string | null) ?? null,
            clientPhone: (clientRow.phone as string | null) ?? null,
            salonName,
            salonLogoUrl: biz?.logo_url ?? null,
            serviceName,
            staffName: staffDisplayName,
            date: formattedDate,
            time: formattedTime,
            reference: bookingReference,
            price: priceDisplay,
            manageUrl: `${appUrl}/owner`,
          });
          sendEmail(ownerNotifEmail, ownerEmailData.subject, ownerEmailData.html).catch(
            (err) => console.error("Owner notification email (manual booking) failed:", err),
          );
        }

        // Staff notification with ICS calendar invite
        if (body.staff_profile_id) {
          const staffEmail = await fetchStaffEmail(body.staff_profile_id as string).catch(() => null);
          if (staffEmail) {
            const startDate = new Date(startsAt);
            const durationMs = (serviceRow.duration_minutes as number) * 60_000;
            const endDate = new Date(startDate.getTime() + durationMs);
            const icsEvent = {
              uid: `appt-${apptId}@kazione.app`,
              summary: `${serviceName} — ${clientName}`,
              description: `Appointment at ${salonName}\nRef: ${bookingReference}`,
              location: salonName,
              startAt: startDate,
              endAt: endDate,
            };
            const icsString = generateIcs(icsEvent);
            const gcalUrl = googleCalendarUrl(icsEvent);
            const staffEmailData = staffNewBookingEmail({
              staffName: staffDisplayName,
              salonName,
              salonLogoUrl: biz?.logo_url ?? null,
              clientName,
              clientPhone: (clientRow.phone as string | null) ?? null,
              serviceName,
              date: formattedDate,
              time: formattedTime,
              reference: bookingReference,
              googleCalendarUrl: gcalUrl,
            });
            sendEmail(
              staffEmail,
              staffEmailData.subject,
              staffEmailData.html,
              undefined,
              [{ filename: "appointment.ics", content: icsToBase64(icsString) }],
            ).catch((err) => console.error("Staff new-booking email failed:", err));
          }
        }

        // Client confirmation email
        const clientEmailAddr = (clientRow.email as string | null) ?? null;
        if (clientEmailAddr) {
          const clientEmailData = bookingConfirmationEmail({
            clientName,
            salonName,
            salonLogoUrl: biz?.logo_url ?? null,
            serviceName,
            staffName: staffDisplayName,
            date: formattedDate,
            time: formattedTime,
            reference: bookingReference,
            price: priceDisplay,
            manageUrl: `${appUrl}/booking/${bookingReference}`,
          });
          sendEmail(clientEmailAddr, clientEmailData.subject, clientEmailData.html).catch(
            (err) => console.error("Client confirmation email (manual booking) failed:", err),
          );
        }
      }

      return jsonCors(req, { ...appointment, payment: null }, 201);
    }

    // ── PATCH ?action=assign-staff ──────────────────────────────────────────
    if (method === "PATCH" && action === "assign-staff") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;
      const staffProfileId = body.staff_profile_id as string | undefined;
      if (!staffProfileId) return badRequest("staff_profile_id is required");

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("appointments")
        .select("business_id, status")
        .eq("id", id)
        .single();

      if (fetchErr || !existing) return notFound("Appointment not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const oldStatus = (existing as Record<string, unknown>).status as string;
      // Completed appointments keep their status; others move to "offered" awaiting staff confirmation
      const newStatus = oldStatus === "completed" ? "completed" : "offered";

      // Atomic: locks the appointment row, re-checks the target staff
      // member's schedule (excluding this appointment's own current slot),
      // then writes — closes the double-booking gap a plain .update() left
      // open (S58).
      const { error: assignErr } = await supabaseAdmin.rpc("assign_staff_atomic", {
        p_appointment_id: id,
        p_staff_id: staffProfileId,
        p_new_status: newStatus,
      });

      if (assignErr) {
        if (isSlotTakenError(assignErr)) {
          return conflict("SLOT_TAKEN", "This staff member already has a conflicting appointment at that time");
        }
        console.error("assign_staff_atomic error:", JSON.stringify(assignErr));
        return serverError(assignErr.message);
      }

      const { data: updated, error: updateErr } = await supabaseAdmin
        .from("appointments")
        .select(APPT_SELECT)
        .eq("id", id)
        .single();

      if (updateErr) return serverError(updateErr.message);

      await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: id,
        old_status: oldStatus,
        new_status: newStatus,
        reason: oldStatus === "completed"
          ? "Staff reassigned on completed appointment — commission records updated"
          : "Staff offered appointment — awaiting confirmation",
      });

      // Notify the offered staff member by email (only for non-completed reassignments)
      if (newStatus === "offered") {
        (async () => {
          try {
            const apptRow = updated as Record<string, unknown>;
            const client = apptRow.client as Record<string, string> | null;
            const service = apptRow.service as Record<string, string> | null;
            const staffEmail = await fetchStaffEmail(staffProfileId);
            if (!staffEmail) return;
            const { data: bizRow } = await supabaseAdmin.from("businesses").select("name, logo_url, timezone").eq("id", apptRow.business_id as string).single();
            const biz = bizRow as Record<string, unknown> | null;
            const bizTz = (biz?.timezone as string | null) ?? "UTC";
            const startsAtDate = new Date(apptRow.starts_at as string);
            const { subject, html } = staffAppointmentOfferEmail({
              staffName: (apptRow.staff as Record<string, string> | null)?.display_name ?? "Team member",
              salonName: (biz?.name as string) ?? "KaziOne",
              salonLogoUrl: biz?.logo_url as string | null ?? null,
              clientName: client ? `${client.first_name} ${client.last_name}` : "Client",
              serviceName: service?.name ?? "Service",
              date: startsAtDate.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: bizTz }),
              time: startsAtDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: bizTz }),
              reference: apptRow.booking_reference as string,
              dashboardUrl: `${Deno.env.get("APP_URL") ?? "https://kazionebooking.com"}/staff`,
            });
            await sendEmail(staffEmail, subject, html).catch((e) => console.warn("assign-staff offer email failed:", e));
          } catch (e) { console.warn("assign-staff offer email error:", e); }
        })();
      }

      return jsonCors(req, normalizePayment(updated as Record<string, unknown>));
    }

    // ── PATCH ?action=assign-staff-2 ──────────────────────────────────────────
    // Owner assigns (or clears) the secondary staff member on a dual-staff appointment.
    // Body: { staff_profile_id_2: string | null }
    if (method === "PATCH" && action === "assign-staff-2") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;
      const staffProfileId2 = (body.staff_profile_id_2 as string | null | undefined) ?? null;

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("appointments")
        .select("business_id, status, service_id")
        .eq("id", id)
        .single();

      if (fetchErr || !existing) return notFound("Appointment not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      // Verify the service requires two staff
      const serviceId2 = (existing as Record<string, unknown>).service_id as string;
      const { data: svcRow } = await supabaseAdmin
        .from("services")
        .select("requires_two_staff, commission_split_pct")
        .eq("id", serviceId2)
        .single();

      if (!svcRow || !(svcRow as Record<string, unknown>).requires_two_staff) {
        return badRequest("Service does not support dual staff assignment");
      }

      // Keep commission_split_pct in sync with the service snapshot
      const splitPct2 = staffProfileId2
        ? Number((svcRow as Record<string, unknown>).commission_split_pct ?? 50)
        : null;

      // Atomic: same pattern as assign-staff — locks the row, re-checks the
      // secondary staff member's schedule (skipped entirely when clearing
      // the assignment), then writes (S58).
      const { error: assign2Err } = await supabaseAdmin.rpc("assign_staff_2_atomic", {
        p_appointment_id: id,
        p_staff_id_2: staffProfileId2,
        p_commission_split_pct: splitPct2,
      });

      if (assign2Err) {
        if (isSlotTakenError(assign2Err)) {
          return conflict("SLOT_TAKEN", "This staff member already has a conflicting appointment at that time");
        }
        console.error("assign_staff_2_atomic error:", JSON.stringify(assign2Err));
        return serverError(assign2Err.message);
      }

      const { data: updated2, error: updateErr2 } = await supabaseAdmin
        .from("appointments")
        .select(APPT_SELECT)
        .eq("id", id)
        .single();

      if (updateErr2) return serverError(updateErr2.message);
      return jsonCors(req, normalizePayment(updated2 as Record<string, unknown>));
    }

    // ── PATCH ?action=respond-offer ────────────────────────────────────────────
    // Staff member accepts or declines an offered appointment.
    // Body: { business_id, response: 'accepted' | 'declined' }
    // Owners/managers may also call this to confirm on behalf of staff.
    if (method === "PATCH" && action === "respond-offer") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;
      const response = body.response as string | undefined;
      if (response !== "accepted" && response !== "declined") {
        return badRequest("response must be 'accepted' or 'declined'");
      }

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("appointments")
        .select("business_id, status, staff_profile_id, staff_profile_id_2")
        .eq("id", id)
        .maybeSingle();

      if (fetchErr || !existing) return notFound("Appointment not found");

      const ex = existing as {
        business_id: string;
        status: string;
        staff_profile_id: string | null;
        staff_profile_id_2: string | null;
      };

      if (ex.status !== "offered") {
        return badRequest(`Cannot respond — appointment is '${ex.status}', not 'offered'`);
      }

      // Track which staff slot the caller occupies (needed for decline clearing)
      let callerIsSecondaryStaff = false;

      // Check if caller is owner/manager; if not, verify they are assigned staff (primary or secondary)
      const ownerResult = await requireOwnerOrManagerCtx(req, ex.business_id);
      if (ownerResult instanceof Response) {
        // Not owner/manager — must be one of the assigned staff members
        try {
          const user = await verifyAuth(req);
          const { data: memberRow } = await supabaseAdmin
            .from("business_members")
            .select("id, role")
            .eq("user_id", user.id)
            .eq("business_id", ex.business_id)
            .eq("is_active", true)
            .maybeSingle();

          if (!memberRow || (memberRow as { role: string }).role !== "staff") {
            return ownerResult;
          }

          const { data: sp } = await supabaseAdmin
            .from("staff_profiles")
            .select("id")
            .eq("business_member_id", (memberRow as { id: string }).id)
            .eq("business_id", ex.business_id)
            .maybeSingle();

          const callerStaffId = (sp as { id: string } | null)?.id ?? null;
          const isPrimary   = callerStaffId === ex.staff_profile_id;
          const isSecondary = callerStaffId === ex.staff_profile_id_2;

          if (!callerStaffId || (!isPrimary && !isSecondary)) {
            return forbidden(req, "You can only respond to your own appointment offers");
          }
          callerIsSecondaryStaff = isSecondary;
        } catch (e) {
          if (e instanceof Response) return e;
          return ownerResult;
        }
      }

      const newStatus = response === "accepted" ? "confirmed" : "pending";
      const updatePayload: Record<string, unknown> = { status: newStatus };
      if (response === "declined") {
        // Clear only the slot that belongs to the decliner
        if (callerIsSecondaryStaff) {
          updatePayload.staff_profile_id_2 = null;
        } else {
          updatePayload.staff_profile_id = null;
        }
      }

      const { data: updated, error: updateErr } = await supabaseAdmin
        .from("appointments")
        .update(updatePayload)
        .eq("id", id)
        .select(APPT_SELECT)
        .single();

      if (updateErr) return serverError(updateErr.message);

      await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: id,
        old_status: "offered",
        new_status: newStatus,
        reason: response === "accepted" ? "Staff accepted appointment" : "Staff declined — returned to unassigned",
      });

      // Notify owner of staff's response
      (async () => {
        try {
          const apptRow = updated as Record<string, unknown>;
          const ownerEmail = await fetchOwnerEmail(ex.business_id);
          if (!ownerEmail) return;
          const { data: bizRow } = await supabaseAdmin.from("businesses").select("name, logo_url, timezone").eq("id", ex.business_id).single();
          const biz = bizRow as Record<string, unknown> | null;
          const bizTz = (biz?.timezone as string | null) ?? "UTC";
          const client = apptRow.client as Record<string, string> | null;
          const service = apptRow.service as Record<string, string> | null;
          const staffDisplayName = (apptRow.staff as Record<string, string> | null)?.display_name ?? "Staff";
          const startsAtDate = new Date(apptRow.starts_at as string);
          const verb = response === "accepted" ? "accepted" : "declined";
          const appUrl = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";
          await sendEmail(
            ownerEmail,
            `${staffDisplayName} ${verb} appointment — ${apptRow.booking_reference}`,
            bookingReceivedOwnerEmail({
              clientName: client ? `${client.first_name} ${client.last_name}` : "Client",
              clientEmail: client?.email ?? null,
              clientPhone: null,
              salonName: (biz?.name as string) ?? "KaziOne",
              salonLogoUrl: biz?.logo_url as string | null ?? null,
              serviceName: service?.name ?? "Service",
              staffName: `${staffDisplayName} (${verb})`,
              date: startsAtDate.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: bizTz }),
              time: startsAtDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: bizTz }),
              reference: apptRow.booking_reference as string,
              price: `€${Number(apptRow.price ?? 0).toFixed(2)}`,
              manageUrl: `${appUrl}/owner/appointments`,
            }).html,
          ).catch((e) => console.warn("respond-offer owner email failed:", e));
        } catch (e) { console.warn("respond-offer owner email error:", e); }
      })();

      return jsonCors(req, normalizePayment(updated as Record<string, unknown>));
    }

    // ── PATCH ?action=reschedule ────────────────────────────────────────────
    if (method === "PATCH" && action === "reschedule") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;
      // date+time are the business's local wall-clock (matching create-booking's
      // contract — S59), not a pre-combined starts_at string.
      const dateStr = body.date as string | undefined;
      const timeStr = body.time as string | undefined;
      if (!dateStr || !DATE_RE.test(dateStr)) return badRequest("date is required (YYYY-MM-DD)");
      if (!timeStr || !TIME_RE.test(timeStr)) return badRequest("time is required (HH:MM)");

      // Fetch existing appointment — simple select, no embedded joins
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("appointments")
        .select("business_id, staff_profile_id, duration_minutes, status, booking_reference, price")
        .eq("id", id)
        .single();

      if (fetchErr || !existing) return notFound("Appointment not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const { data: bizRow, error: bizErr } = await supabaseAdmin
        .from("businesses")
        .select("timezone")
        .eq("id", ctx.businessId)
        .maybeSingle();
      if (bizErr) return serverError(bizErr.message);

      const ex = existing as Record<string, unknown>;
      const durationMs = (ex.duration_minutes as number) * 60_000;
      const newStartsAt = localWallClockToUtcIso(dateStr, timeStr, bizRow?.timezone ?? "UTC");
      const startsAt = new Date(newStartsAt);
      const endsAt = new Date(startsAt.getTime() + durationMs);

      const { error: updateErr } = await supabaseAdmin
        .from("appointments")
        .update({ starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), status: "confirmed" })
        .eq("id", id);

      if (updateErr) return serverError(updateErr.message);

      // Fetch the updated appointment separately — avoids UPDATE+JOIN issues
      const { data: updated, error: fetchUpdatedErr } = await supabaseAdmin
        .from("appointments")
        .select(APPT_SELECT)
        .eq("id", id)
        .single();

      if (fetchUpdatedErr || !updated) return serverError("Failed to fetch updated appointment");

      await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: id,
        old_status: ex.status,
        new_status: "confirmed",
        changed_by: ctx.userId,
        reason: (body.reason as string | undefined) ?? "rescheduled",
      });

      // ── Email notifications ─────────────────────────────────────────────
      try {
        const { data: bizRow } = await supabaseAdmin
          .from("businesses")
          .select("name, logo_url, timezone")
          .eq("id", ex.business_id as string)
          .single();

        const [ownerEmail, staffEmail] = await Promise.all([
          fetchOwnerEmail(ex.business_id as string),
          ex.staff_profile_id ? fetchStaffEmail(ex.staff_profile_id as string) : Promise.resolve(null),
        ]);

        const biz = bizRow as Record<string, unknown> | null;
        const bizTz = (biz?.timezone as string | null) ?? "UTC";
        const updatedRecord = updated as Record<string, unknown>;
        const client = updatedRecord.client as Record<string, string>;
        const service = updatedRecord.service as Record<string, string>;
        const staffDisplayName = (updatedRecord.staff as Record<string, string> | null)?.display_name ?? "your stylist";
        const clientEmail = client?.email ?? null;
        const salonName = (biz?.name as string) ?? "KaziOne";
        const clientName = client ? `${client.first_name} ${client.last_name}` : "Client";
        const serviceName = service?.name ?? "Service";
        const formattedDate = startsAt.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: bizTz });
        const formattedTime = startsAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: bizTz });
        const ref = ex.booking_reference as string;

        // ICS for reschedule (same UID — calendar clients update existing event)
        const durationMs = (ex.duration_minutes as number) * 60_000;
        const endDate = new Date(startsAt.getTime() + durationMs);
        const icsEvent = {
          uid: `appt-${id}@kazione.app`,
          summary: `${serviceName} — ${clientName}`,
          description: `Appointment at ${salonName}\nRef: ${ref}`,
          location: salonName,
          startAt: startsAt,
          endAt: endDate,
        };
        const icsString = generateIcs(icsEvent);
        const icsAttachment = [{ filename: "appointment.ics", content: icsToBase64(icsString) }];

        const emailData = {
          clientName,
          salonName,
          salonLogoUrl: biz?.logo_url as string | undefined,
          serviceName,
          staffName: staffDisplayName,
          date: formattedDate,
          time: formattedTime,
          reference: ref,
          price: `€${(ex.price as number).toFixed(2)}`,
          manageUrl: `${Deno.env.get("STOREFRONT_BASE_URL") ?? "https://kazione.app"}/client/bookings`,
        };

        const recipients: string[] = [];
        if (clientEmail) recipients.push(clientEmail);
        if (staffEmail) recipients.push(staffEmail);
        if (ownerEmail && ownerEmail !== clientEmail) recipients.push(ownerEmail);

        const { subject, html } = bookingRescheduleEmail(emailData);
        for (const to of recipients) {
          await sendEmail(to, subject, html, undefined, icsAttachment).catch((e) =>
            console.warn(`reschedule email to ${to} failed:`, e),
          );
        }
      } catch (emailErr) {
        console.warn("reschedule email notification failed:", emailErr);
      }

      return jsonCors(req, normalizePayment(updated));
    }

    // ── PATCH ?action=mark_commission_paid ─────────────────────────────────
    // Supports retroactive marking: works on any completed appointment regardless
    // of when it was booked. Passing paid=false clears the paid timestamp.
    if (method === "PATCH" && action === "mark_commission_paid") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;

      const { data: appt } = await supabaseAdmin
        .from("appointments")
        .select("business_id, status, staff_profile_id, price")
        .eq("id", id)
        .is("deleted_at", null)
        .maybeSingle();

      if (!appt) return notFound("Appointment not found");
      const apptRow = appt as { business_id: string; status: string; staff_profile_id: string | null; price: number };

      if (apptRow.status !== "completed") {
        return badRequest("Commission can only be marked on completed appointments");
      }

      const ctx = await requireOwnerOrManagerCtx(req, apptRow.business_id);
      if (ctx instanceof Response) return ctx;

      const clearing = body.paid === false;

      const updateFields: Record<string, unknown> = clearing
        ? { commission_paid_at: null, commission_pay_method: null, commission_amount_paid: null }
        : {
            commission_paid_at: new Date().toISOString(),
            commission_pay_method: (body.pay_method as string | undefined) ?? "manual",
            commission_amount_paid: typeof body.amount === "number" ? body.amount : null,
          };

      const { error: updateErr } = await supabaseAdmin
        .from("appointments")
        .update(updateFields)
        .eq("id", id);

      if (updateErr) return serverError("Failed to update commission status");

      return jsonCors(req, { success: true });
    }

    // ── PATCH ──────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;

      // Fetch appointment to get business_id for auth (+ service_id for stock-out + price for payment settlement)
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("appointments")
        .select("status, business_id, service_id, staff_profile_id, staff_profile_id_2, price")
        .eq("id", id)
        .single();

      if (fetchErr || !existing) return notFound("Appointment not found");

      const existingRow = existing as {
        status: string;
        business_id: string;
        service_id: string | null;
        staff_profile_id: string | null;
        staff_profile_id_2: string | null;
        price: number;
      };

      // Owner/manager OR assigned staff may update status (staff portal MS1)
      const ownerResult = await requireOwnerOrManagerCtx(req, existingRow.business_id);
      let ctx: { userId: string; businessId: string; role: string };
      if (ownerResult instanceof Response) {
        try {
          const user = await verifyAuth(req);
          const { data: memberRow } = await supabaseAdmin
            .from("business_members")
            .select("id, role")
            .eq("user_id", user.id)
            .eq("business_id", existingRow.business_id)
            .eq("is_active", true)
            .maybeSingle();
          if (!memberRow || (memberRow as { role: string }).role !== "staff") {
            return ownerResult;
          }
          const { data: sp } = await supabaseAdmin
            .from("staff_profiles")
            .select("id")
            .eq("business_member_id", (memberRow as { id: string }).id)
            .eq("business_id", existingRow.business_id)
            .maybeSingle();
          const callerStaffId = (sp as { id: string } | null)?.id ?? null;
          if (!callerStaffId || callerStaffId !== existingRow.staff_profile_id) {
            return forbidden("You can only update your own appointments");
          }
          ctx = {
            userId: user.id,
            businessId: existingRow.business_id,
            role: "staff",
          };
        } catch (e) {
          if (e instanceof Response) return e;
          return ownerResult;
        }
      } else {
        ctx = ownerResult;
      }

      const status = body.status as string;
      const reason = body.reason as string | undefined;
      const changedBy = (body.changed_by as string | undefined) ?? ctx.userId;
      const paymentMethod = body.payment_method as string | undefined;
      // If provided (even as empty array), use explicit product overrides instead of auto-deducting all
      const productOverrides = (body.product_overrides ?? null) as Array<{ product_id: string; quantity: number }> | null;

      // Staff-only: may only set pending_completion on their own confirmed/in_progress appointments.
      // Owners may set any status including completing a pending_completion.
      if (status === "pending_completion" && ctx.role !== "staff") {
        return badRequest("Only staff may submit pending_completion");
      }
      const allowedFromStatuses: string[] = ["confirmed", "in_progress", "pending", "offered", "pending_completion"];
      if (!allowedFromStatuses.includes(existingRow.status)) {
        return badRequest(`Cannot transition from '${existingRow.status}' to '${status}'`);
      }

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

      // Cancellation email notifications
      if (status === "cancelled") {
        (async () => {
          try {
            const apptRow = data as Record<string, unknown>;
            const client = apptRow.client as Record<string, string> | null;
            const service = apptRow.service as Record<string, string> | null;
            const staffProfileId = apptRow.staff_profile_id as string | null;
            const businessId = (existing as Record<string, unknown>).business_id as string;

            const { data: bizRow } = await supabaseAdmin
              .from("businesses")
              .select("name, logo_url, timezone")
              .eq("id", businessId)
              .single();

            const [ownerEmail, staffEmail] = await Promise.all([
              fetchOwnerEmail(businessId),
              staffProfileId ? fetchStaffEmail(staffProfileId) : Promise.resolve(null),
            ]);

            const biz = bizRow as Record<string, unknown> | null;
            const bizTz = (biz?.timezone as string | null) ?? "UTC";
            const salonName = (biz?.name as string) ?? "KaziOne";
            const clientName = client ? `${client.first_name} ${client.last_name}` : "Client";
            const clientEmail = client?.email ?? null;
            const serviceName = service?.name ?? "Service";
            const staffDisplayName = (apptRow.staff as Record<string, string> | null)?.display_name ?? "your stylist";
            const startsAtStr = apptRow.starts_at as string;
            const startsAtDate = new Date(startsAtStr);
            const formattedDate = startsAtDate.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: bizTz });
            const formattedTime = startsAtDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: bizTz });
            const ref = apptRow.booking_reference as string;

            // CANCEL ICS removes the event from calendars that already have it
            const durationMs = (apptRow.duration_minutes as number ?? service?.duration_minutes as unknown as number ?? 60) * 60_000;
            const cancelIcs = generateIcs({
              uid: `appt-${id}@kazione.app`,
              summary: `${serviceName} — ${clientName}`,
              startAt: startsAtDate,
              endAt: new Date(startsAtDate.getTime() + durationMs),
              cancel: true,
            });
            const cancelAttachment = [{ filename: "cancelled.ics", content: icsToBase64(cancelIcs) }];

            // Client cancellation email
            if (clientEmail) {
              const { subject, html } = bookingCancellationEmail({
                clientName,
                salonName,
                salonLogoUrl: biz?.logo_url as string | undefined,
                serviceName,
                staffName: staffDisplayName,
                date: formattedDate,
                time: formattedTime,
                reference: ref,
                price: `€${Number(apptRow.price ?? 0).toFixed(2)}`,
                manageUrl: `${Deno.env.get("STOREFRONT_BASE_URL") ?? "https://kazione.app"}/book`,
              });
              sendEmail(clientEmail, subject, html, undefined, cancelAttachment).catch((e) =>
                console.warn(`cancel email to client failed:`, e),
              );
            }

            // Staff cancellation email
            if (staffEmail) {
              const { subject, html } = staffBookingCancellationEmail({
                staffName: staffDisplayName,
                salonName,
                salonLogoUrl: biz?.logo_url as string | null ?? null,
                clientName,
                serviceName,
                date: formattedDate,
                time: formattedTime,
                reference: ref,
                reason: reason ?? null,
              });
              sendEmail(staffEmail, subject, html, undefined, cancelAttachment).catch((e) =>
                console.warn(`cancel email to staff failed:`, e),
              );
            }

            // Owner cancellation notification
            if (ownerEmail && ownerEmail !== clientEmail) {
              const { subject, html } = bookingCancellationEmail({
                clientName,
                salonName,
                salonLogoUrl: biz?.logo_url as string | undefined,
                serviceName,
                staffName: staffDisplayName,
                date: formattedDate,
                time: formattedTime,
                reference: ref,
                price: `€${Number(apptRow.price ?? 0).toFixed(2)}`,
                manageUrl: `${Deno.env.get("APP_URL") ?? "https://kazionebooking.com"}/owner`,
              });
              sendEmail(ownerEmail, subject, html).catch((e) =>
                console.warn(`cancel email to owner failed:`, e),
              );
            }
          } catch (cancelEmailErr) {
            console.warn("cancellation email notification failed:", cancelEmailErr);
          }
        })();
      }

      // When staff submits pending_completion: save payment method on payments table and email owner
      if (status === "pending_completion") {
        const submittedMethod = paymentMethod ?? "cash";
        const pendingRow = existing as Record<string, unknown>;
        const businessId = pendingRow.business_id as string;
        const price = Number(pendingRow.price ?? 0);

        const { data: existingPayment } = await supabaseAdmin
          .from("payments")
          .select("id, status")
          .eq("appointment_id", id)
          .maybeSingle();

        if (existingPayment) {
          await supabaseAdmin
            .from("payments")
            .update({ method: submittedMethod })
            .eq("id", (existingPayment as Record<string, unknown>).id as string);
        } else if (price > 0) {
          await supabaseAdmin.from("payments").insert({
            business_id: businessId,
            appointment_id: id,
            amount: price,
            status: "pending",
            method: submittedMethod,
          });
        }

        // Notify owner
        (async () => {
          try {
            const apptRow = data as Record<string, unknown>;
            const ownerEmail = await fetchOwnerEmail(businessId);
            if (!ownerEmail) return;
            const { data: bizRow } = await supabaseAdmin.from("businesses").select("name, logo_url, timezone").eq("id", businessId).single();
            const biz = bizRow as Record<string, unknown> | null;
            const bizTz = (biz?.timezone as string | null) ?? "UTC";
            const client = apptRow.client as Record<string, string> | null;
            const service = apptRow.service as Record<string, string> | null;
            const staffDisplayName = (apptRow.staff as Record<string, string> | null)?.display_name ?? "Staff";
            const startsAtDate = new Date(apptRow.starts_at as string);
            const appUrl = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";
            const { subject, html } = ownerPendingCompletionEmail({
              salonName: (biz?.name as string) ?? "KaziOne",
              salonLogoUrl: biz?.logo_url as string | null ?? null,
              staffName: staffDisplayName,
              clientName: client ? `${client.first_name} ${client.last_name}` : "Client",
              serviceName: service?.name ?? "Service",
              date: startsAtDate.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: bizTz }),
              time: startsAtDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: bizTz }),
              reference: apptRow.booking_reference as string,
              paymentMethod: submittedMethod,
              dashboardUrl: `${appUrl}/owner/appointments`,
            });
            await sendEmail(ownerEmail, subject, html).catch((e) => console.warn("pending_completion owner email failed:", e));
          } catch (e) { console.warn("pending_completion owner email error:", e); }
        })();
      }

      // Settle payment when appointment is marked completed
      if (status === "completed") {
        const completedRow = existing as Record<string, unknown>;
        const businessIdForPayment = completedRow.business_id as string;
        const price = Number(completedRow.price ?? 0);

        const { data: existingPayment } = await supabaseAdmin
          .from("payments")
          .select("id, status, method")
          .eq("appointment_id", id)
          .maybeSingle();

        // Use body.payment_method if provided; otherwise fall back to what staff already saved
        const method = paymentMethod ?? (existingPayment as Record<string, unknown> | null)?.method as string ?? "cash";

        if (existingPayment) {
          const pay = existingPayment as Record<string, unknown>;
          if (pay.status !== "paid") {
            await supabaseAdmin
              .from("payments")
              .update({ status: "paid", paid_at: new Date().toISOString(), method })
              .eq("id", pay.id as string);
          }
        } else if (price > 0) {
          await supabaseAdmin.from("payments").insert({
            business_id: businessIdForPayment,
            appointment_id: id,
            amount: price,
            status: "paid",
            method,
            paid_at: new Date().toISOString(),
          });
        }

        // Auto-pay commission if the business has enabled it
        if (existingRow.staff_profile_id) {
          const { data: bizSettings } = await supabaseAdmin
            .from("business_settings")
            .select("commission_auto_pay, commission_auto_pay_method")
            .eq("business_id", businessIdForPayment)
            .maybeSingle();
          const autoPayRow = bizSettings as { commission_auto_pay: boolean; commission_auto_pay_method: string } | null;
          if (autoPayRow?.commission_auto_pay) {
            const [svcRes, spRes] = await Promise.all([
              supabaseAdmin.from("services").select("staff_commission_type, staff_commission_value").eq("id", existingRow.service_id!).maybeSingle(),
              supabaseAdmin.from("staff_profiles").select("commission_rate").eq("id", existingRow.staff_profile_id).maybeSingle(),
            ]);
            const svc = svcRes.data as { staff_commission_type: string | null; staff_commission_value: number | null } | null;
            const sp = spRes.data as { commission_rate: number | null } | null;
            const commType = svc?.staff_commission_type ?? "none";
            const commValue = Number(svc?.staff_commission_value ?? 0);
            const staffRate = Number(sp?.commission_rate ?? 0);
            let commissionAmount = 0;
            if (commType === "percentage" && commValue > 0) {
              commissionAmount = Math.round(price * commValue / 100 * 100) / 100;
            } else if (commType === "fixed" && commValue > 0) {
              commissionAmount = commValue;
            } else if (staffRate > 0) {
              commissionAmount = Math.round(price * staffRate / 100 * 100) / 100;
            }
            if (commissionAmount > 0) {
              await supabaseAdmin.from("appointments").update({
                commission_paid_at: new Date().toISOString(),
                commission_pay_method: autoPayRow.commission_auto_pay_method,
                commission_amount_paid: commissionAmount,
              }).eq("id", id).is("commission_paid_at", null);
            }
          }
        }

        // Notify staff when owner confirms completion
        const staffProfileIdForComplete = existingRow.staff_profile_id as string | null;
        if (staffProfileIdForComplete) {
          (async () => {
            try {
              const staffEmail = await fetchStaffEmail(staffProfileIdForComplete);
              if (!staffEmail) return;
              const apptRow = data as Record<string, unknown>;
              const { data: bizRow } = await supabaseAdmin.from("businesses").select("name, logo_url, timezone").eq("id", existingRow.business_id).single();
              const biz = bizRow as Record<string, unknown> | null;
              const bizTz = (biz?.timezone as string | null) ?? "UTC";
              const client = apptRow.client as Record<string, string> | null;
              const service = apptRow.service as Record<string, string> | null;
              const staffDisplayName = (apptRow.staff as Record<string, string> | null)?.display_name ?? "Team member";
              const startsAtDate = new Date(apptRow.starts_at as string);
              const { subject, html } = staffCompletionConfirmedEmail({
                staffName: staffDisplayName,
                salonName: (biz?.name as string) ?? "KaziOne",
                salonLogoUrl: biz?.logo_url as string | null ?? null,
                clientName: client ? `${client.first_name} ${client.last_name}` : "Client",
                serviceName: service?.name ?? "Service",
                date: startsAtDate.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: bizTz }),
                reference: apptRow.booking_reference as string,
              });
              await sendEmail(staffEmail, subject, html).catch((e) => console.warn("completion confirmed staff email failed:", e));
            } catch (e) { console.warn("completion confirmed staff email error:", e); }
          })();
        }
      }

      // Generate review token and email client when appointment is completed
      if (status === "completed") {
        (async () => {
          try {
            const apptRow = data as Record<string, unknown>;
            const client = apptRow.client as Record<string, string> | null;
            const clientEmail = client?.email ?? null;
            if (!clientEmail) return;

            const { data: bizRow } = await supabaseAdmin.from("businesses").select("name, logo_url, slug").eq("id", existingRow.business_id).single();
            const biz = bizRow as Record<string, unknown> | null;
            const service = apptRow.service as Record<string, string> | null;

            // Generate a 16-byte hex token
            const tokenBytes = crypto.getRandomValues(new Uint8Array(16));
            const reviewToken = Array.from(tokenBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

            // Upsert review row with token (creates the row; rating filled later by client)
            const { data: existingReview } = await supabaseAdmin
              .from("reviews")
              .select("id")
              .eq("appointment_id", id)
              .maybeSingle();

            if (existingReview) {
              await supabaseAdmin
                .from("reviews")
                .update({ review_token: reviewToken })
                .eq("id", (existingReview as Record<string, unknown>).id as string);
            } else {
              await supabaseAdmin.from("reviews").insert({
                business_id: existingRow.business_id,
                client_id: apptRow.client_id,
                appointment_id: id,
                rating: 5, // placeholder — overwritten when client submits
                is_public: false,
                review_token: reviewToken,
              });
            }

            const appUrl = Deno.env.get("STOREFRONT_BASE_URL") ?? "https://kazione.app";
            const reviewUrl = `${appUrl}/review?token=${reviewToken}`;
            const { subject, html } = reviewRequestEmail({
              clientName: client ? `${client.first_name} ${client.last_name}` : "there",
              salonName: (biz?.name as string) ?? "KaziOne",
              salonLogoUrl: biz?.logo_url as string | undefined,
              serviceName: service?.name ?? "your appointment",
              reviewUrl,
            });

            await sendEmail(clientEmail, subject, html).catch((e) =>
              console.warn("review request email failed:", e),
            );
          } catch (e) {
            console.warn("review token generation failed:", e);
          }
        })();
      }

      // Auto stock-out: when appointment completed, deduct product usage
      if (status === "completed") {
        const existingRow = existing as Record<string, unknown>;
        const serviceId = existingRow.service_id as string | null;
        const businessId = existingRow.business_id as string;

        // Build the list of items to deduct:
        // - If product_overrides is explicitly provided (even empty), use those
        // - Otherwise fall back to all service_product_usage rows
        const deductItems: { product_id: string; quantity: number; unit_cost?: number | null }[] = [];

        if (productOverrides !== null) {
          for (const o of productOverrides) {
            if (o.product_id && o.quantity > 0) deductItems.push(o);
          }
        } else if (serviceId) {
          const { data: usageRows } = await supabaseAdmin
            .from("service_product_usage")
            .select("product_id, quantity_per_service, product:product_catalog(unit_cost)")
            .eq("service_id", serviceId);
          for (const u of (usageRows ?? []) as Record<string, unknown>[]) {
            const productData = u.product as Record<string, unknown> | null;
            deductItems.push({
              product_id: u.product_id as string,
              quantity: Number(u.quantity_per_service),
              unit_cost: (productData?.unit_cost as number | null) ?? null,
            });
          }
        }

        if (deductItems.length > 0) {
          const movements = deductItems.map((u) => ({
            business_id: businessId,
            product_id: u.product_id,
            movement_type: "service_use",
            quantity: -u.quantity,
            unit_cost: u.unit_cost ?? null,
            reference_id: id,
            reference_type: "appointment",
            created_by: changedBy ?? null,
          }));

          const { error: mvErr } = await supabaseAdmin.from("stock_movements").insert(movements);
          if (mvErr) console.error("stock_movements insert error:", mvErr.message);

          for (const u of deductItems) {
            const { data: prod } = await supabaseAdmin
              .from("product_catalog")
              .select("current_stock")
              .eq("id", u.product_id)
              .single();
            if (prod) {
              await supabaseAdmin
                .from("product_catalog")
                .update({
                  current_stock: (prod as Record<string, unknown>).current_stock as number - u.quantity,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", u.product_id);
            }
          }
        }
      }

      // Auto-create commission tasks when appointment is completed
      if (status === "completed") {
        try {
          const apptRow = data as Record<string, unknown>;
          // Optional manual overrides: [{ staff_profile_id, amount }]
          const commissionOverrides = (body.commission_overrides ?? null) as
            Array<{ staff_profile_id: string; amount: number }> | null;

          const staffIds = [
            existingRow.staff_profile_id,
            existingRow.staff_profile_id_2,
          ].filter(Boolean) as string[];

          for (const staffId of staffIds) {
            const override = commissionOverrides?.find((o) => o.staff_profile_id === staffId);
            let commissionAmount: number;
            let displayName: string;

            if (override) {
              // Operator entered amount manually — look up name only
              const { data: sp } = await supabaseAdmin
                .from("staff_profiles")
                .select("display_name")
                .eq("id", staffId)
                .single();
              displayName = (sp as { display_name: string } | null)?.display_name ?? staffId;
              commissionAmount = override.amount;
            } else {
              const { data: sp } = await supabaseAdmin
                .from("staff_profiles")
                .select("display_name, commission_rate")
                .eq("id", staffId)
                .single();
              const spRow = sp as { display_name: string; commission_rate: number | null } | null;
              if (!spRow || !spRow.commission_rate) continue;
              displayName = spRow.display_name;
              commissionAmount = Number(existingRow.price ?? 0) * (spRow.commission_rate / 100);
            }

            if (commissionAmount <= 0) continue;

            await supabaseAdmin.from("owner_tasks").insert({
              business_id: existingRow.business_id,
              type: "commission_payment",
              ref_id: id,
              ref_type: "appointment",
              title: `Commission due: ${displayName}`,
              body: {
                staff_name: displayName,
                staff_profile_id: staffId,
                commission_amount: commissionAmount,
                appointment_id: id,
                booking_reference: apptRow.booking_reference ?? null,
              },
            });
          }
        } catch (taskErr) {
          console.warn("commission task insert error:", taskErr);
        }
      }

      return jsonCors(req, normalizePayment(data));
    }

    // ── DELETE ?id= — soft delete (cancelled or completed) ──────────────────
    if (method === "DELETE") {
      if (!id) return badRequest("id is required");

      // payment_action: "mark_test" | "remove" | absent
      // Only applies when deleting a completed appointment that has a payment.
      const paymentAction = url.searchParams.get("payment_action") as "mark_test" | "remove" | null;

      const { data: existing } = await supabaseAdmin
        .from("appointments")
        .select("business_id, status")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (!existing) return notFound("Appointment not found");

      const appt = existing as Record<string, unknown>;
      if (appt.status !== "cancelled" && appt.status !== "completed") {
        return jsonCors(req,
          { error: { code: "INVALID_STATE", message: "Only cancelled or completed appointments can be deleted" } },
          409,
        );
      }

      const ctx = await requireOwnerOrManagerCtx(req, appt.business_id as string);
      if (ctx instanceof Response) return ctx;

      // Handle payment action for completed appointments
      if (appt.status === "completed" && paymentAction === "remove") {
        await supabaseAdmin.from("payments").delete().eq("appointment_id", id);
      } else if (appt.status === "completed" && paymentAction === "mark_test") {
        await supabaseAdmin.from("payments").update({ is_test: true }).eq("appointment_id", id);
      }

      const { error } = await supabaseAdmin
        .from("appointments")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", id);
      if (error) return serverError(error.message);

      return jsonCors(req, { success: true });
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("appointments error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
