import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, conflict, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, requireOwnerManagerOrSupervisorCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";
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
import { localDateRangeToUtcIso, localWallClockToUtcIso, utcIsoToLocalParts } from "../_shared/timezone.ts";
import { getBookingNotificationRecipients } from "../_shared/bookingNotificationRecipients.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

const APPT_SELECT = `
  *,
  client:clients!inner(id, first_name, last_name, email, phone, avatar_url),
  service:services!inner(id, name, duration_minutes, price, staff_commission_type, staff_commission_value, requires_two_staff, commission_split_pct, service_product_usage(quantity_per_service, product:product_catalog(unit_cost))),
  staff:staff_profiles!staff_profile_id(id, display_name, avatar_url, commission_rate),
  staff2:staff_profiles!staff_profile_id_2(id, display_name, avatar_url, commission_rate),
  referrer_staff:staff_profiles!referrer_staff_id(id, display_name, avatar_url),
  payment:payments(status, amount, method, paid_at, refund_amount, is_test),
  applied_offer:offer_redemptions!offer_redemption_id(id, status, offer:business_offers(id, type, title, discount_type, discount_value)),
  business:businesses(name, timezone)
`;

function normalizePayment(row: Record<string, unknown>) {
  const payment = row.payment as unknown[];
  return { ...row, payment: payment?.[0] ?? null };
}

/**
 * The single formula for "what commission does this staff member earn on
 * this appointment" — the service's own commission config takes priority
 * over the staff profile's personal commission_rate, scaled by `fraction`
 * (a staff's share of commission_split_pct when two staff are on the
 * appointment). Used for the staff-visible commission_earned figure, the
 * auto-pay-on-complete amount, and the commission_payment task created on
 * manual completion — those three call sites must never compute this
 * differently, or the amount a staff member sees quoted can silently
 * diverge from what actually gets paid/logged.
 */
function calcCommissionAmount(
  commType: string | null | undefined,
  commValue: number,
  rate: number,
  price: number,
  fraction: number,
): number {
  if (commType === "percentage" && commValue > 0) {
    return Math.round(price * commValue / 100 * fraction * 100) / 100;
  }
  if (commType === "fixed" && commValue > 0) {
    return Math.round(commValue * fraction * 100) / 100;
  }
  if (rate > 0) {
    return Math.round(price * rate / 100 * fraction * 100) / 100;
  }
  return 0;
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

async function fetchStaffUserId(staffProfileId: string): Promise<string | null> {
  const { data: sp } = await supabaseAdmin
    .from("staff_profiles")
    .select("business_member_id")
    .eq("id", staffProfileId)
    .maybeSingle();
  const memberId = (sp as Record<string, unknown> | null)?.business_member_id as string | null;
  if (!memberId) return null;
  const { data: bm } = await supabaseAdmin
    .from("business_members")
    .select("user_id")
    .eq("id", memberId)
    .maybeSingle();
  return ((bm as Record<string, unknown> | null)?.user_id as string | null) ?? null;
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

      // Notification delivery log for a given appointment — S62 support tool:
      // "did we actually try to send this customer their reminder, and did it work."
      if (action === "notification-log") {
        const appointmentId = url.searchParams.get("appointment_id");
        if (!appointmentId) return badRequest("appointment_id is required");

        const { data: apptRow, error: apptErr } = await supabaseAdmin
          .from("appointments")
          .select("id, business_id")
          .eq("id", appointmentId)
          .maybeSingle();

        if (apptErr) return serverError(apptErr.message);
        if (!apptRow) return notFound("Appointment not found");

        const ctx = await requireOwnerOrManagerCtx(req, (apptRow as { business_id: string }).business_id);
        if (ctx instanceof Response) return ctx;

        const { data: logRows, error: logErr } = await supabaseAdmin
          .from("notification_delivery_log")
          .select("id, channel, recipient_type, purpose, status, provider_message_id, error_message, created_at")
          .eq("appointment_id", appointmentId)
          .order("created_at", { ascending: false });

        if (logErr) return serverError(logErr.message);
        return jsonCors(req, logRows ?? []);
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

        const { data: draftRow } = await supabaseAdmin
          .from("appointment_completion_drafts")
          .select("step, payload")
          .eq("appointment_id", id)
          .maybeSingle();

        // Sum of everything actually received so far (paid + the retained
        // portion of any partial refund), across every payment row this
        // appointment has ever had — not just the single row `payment`
        // (below) collapses to. This is what the completion wizard's
        // "previously received" figure has to reconcile against so an
        // existing deposit is never counted twice.
        const paymentRows = ((data as Record<string, unknown>).payment ?? []) as Array<{
          status: string;
          amount: number | string;
          refund_amount: number | string | null;
          is_test: boolean | null;
        }>;
        const previouslyReceived = paymentRows
          .filter((p) => (p.status === "paid" || p.status === "partial_refund") && !p.is_test)
          .reduce((sum, p) => sum + (Number(p.amount) || 0) - (Number(p.refund_amount) || 0), 0);

        return jsonCors(req, {
          ...normalizePayment(data),
          status_log: statusLog ?? [],
          previously_received: Math.round(previouslyReceived * 100) / 100,
          completion_draft: draftRow ?? null,
        });
      }

      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      // Verify user is at least a business member for reads.
      // If the caller is a staff member, capture their staff_profile_id
      // so we can filter the appointment list to only their assignments —
      // unless they're a supervisor, or the business has staff_see_all_appointments
      // on, in which case the list-scope restriction below is skipped (but
      // callerStaffProfileId stays set, since it's also used further down to
      // annotate each row with this caller's own commission_earned).
      let callerStaffProfileId: string | null = null;
      let staffCanSeeAll = false;
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
            .select("id, is_supervisor")
            .eq("business_member_id", (memberRow as { id: string }).id)
            .eq("business_id", businessId)
            .maybeSingle();
          const spRow = sp as { id: string; is_supervisor: boolean } | null;
          callerStaffProfileId = spRow?.id ?? null;
          if (spRow?.is_supervisor) {
            staffCanSeeAll = true;
          } else {
            const { data: settingsRow } = await supabaseAdmin
              .from("business_settings")
              .select("staff_see_all_appointments")
              .eq("business_id", businessId)
              .maybeSingle();
            staffCanSeeAll = (settingsRow as { staff_see_all_appointments: boolean | null } | null)
              ?.staff_see_all_appointments === true;
          }
        }
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }

      if (action === "kpis") {
        // get_owner_dashboard_kpis defaults p_date to the Postgres session's
        // CURRENT_DATE (UTC on Supabase) when omitted — wrong "today" for any
        // business outside UTC, especially near local midnight. Resolve the
        // business's actual local calendar date here and pass it explicitly.
        const { data: bizTzRow } = await supabaseAdmin
          .from("businesses")
          .select("timezone")
          .eq("id", businessId)
          .maybeSingle();
        const todayLocal = utcIsoToLocalParts(
          new Date().toISOString(),
          (bizTzRow as { timezone: string } | null)?.timezone ?? "UTC",
        ).date;

        const { data, error } = await supabaseAdmin.rpc("get_owner_dashboard_kpis", {
          p_business_id: businessId,
          p_date: todayLocal,
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

      // dateFrom/dateTo are business-local calendar dates (e.g. from the
      // owner dashboard's "today"), not UTC ones — comparing them against
      // starts_at (a true UTC timestamptz) as bare strings silently applied
      // UTC-day boundaries instead, mis-scoping "today"/period queries for
      // any business outside UTC (same bug class as the dashboard KPIs fix
      // above). Resolve the business's timezone once and convert each
      // boundary to a true UTC instant before filtering.
      if (dateFrom || dateTo) {
        const { data: bizTzForRange } = await supabaseAdmin
          .from("businesses")
          .select("timezone")
          .eq("id", businessId)
          .maybeSingle();
        const rangeTz = (bizTzForRange as { timezone: string } | null)?.timezone ?? "UTC";
        if (dateFrom) query = query.gte("starts_at", localDateRangeToUtcIso(dateFrom, rangeTz).startUtcIso);
        if (dateTo)   query = query.lt("starts_at", localDateRangeToUtcIso(dateTo, rangeTz).endUtcIsoExclusive);
      }
      if (statusParams?.length) query = query.in("status", statusParams);
      // Ordinary staff callers: restrict to their own appointments (primary or
      // secondary role). Owner/manager, and supervisors or staff covered by
      // staff_see_all_appointments: respect the optional staffId param instead
      // (typically omitted by those callers, meaning "everyone").
      if (callerStaffProfileId && !staffCanSeeAll) {
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

        const commissionApplies =
          (commType === "percentage" && commValue > 0) ||
          (commType === "fixed" && commValue > 0) ||
          myRate > 0;
        const commissionEarned = commissionApplies
          ? calcCommissionAmount(commType, commValue, myRate, price, myFraction)
          : null;

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
        const [recipients, notifBizRes] = await Promise.all([
          getBookingNotificationRecipients(ctx.businessId),
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

        // Booking notification — every supervisor, or the owner if none is set
        for (const recipient of recipients) {
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
          sendEmail(recipient.email, ownerEmailData.subject, ownerEmailData.html).catch(
            (err) => console.error("Booking notification email (manual booking) failed:", err),
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

      const ctx = await requireOwnerManagerOrSupervisorCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const oldStatus = (existing as Record<string, unknown>).status as string;
      // Owner/manager may reassign a completed appointment (commission
      // correction) — a supervisor may only reassign appointments that
      // aren't completed yet.
      if (ctx.role === "supervisor" && oldStatus === "completed") {
        return forbidden("Supervisors cannot reassign a completed appointment");
      }
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

            const staffUserId = await fetchStaffUserId(staffProfileId);
            if (staffUserId) {
              await supabaseAdmin.from("notifications").insert({
                business_id: apptRow.business_id,
                user_id: staffUserId,
                type: "appointment_offer",
                title: "New appointment offer",
                body: `${client ? `${client.first_name} ${client.last_name}` : "A client"} — ${service?.name ?? "Service"} on ${startsAtDate.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: bizTz })} at ${startsAtDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: bizTz })}`,
                metadata: {
                  appointment_id: apptRow.id,
                  booking_reference: apptRow.booking_reference,
                },
              }).then(({ error: notifErr }) => {
                if (notifErr) console.warn("assign-staff offer notification failed:", notifErr);
              });
            }
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

      const ctx = await requireOwnerManagerOrSupervisorCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;
      if (ctx.role === "supervisor" && (existing as Record<string, unknown>).status === "completed") {
        return forbidden("Supervisors cannot reassign a completed appointment");
      }

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

    // ── PATCH ?action=adjust-final-price ────────────────────────────────────
    // Owner/manager/supervisor may set an authorized, audited override of
    // what this appointment is actually being charged (Complete-appointment
    // wizard, Step 1 "Edit price"). `price` — the original booking value —
    // is never touched; appointment_price_log keeps the before/after/reason
    // trail. Body: { final_price, reason }.
    if (method === "PATCH" && action === "adjust-final-price") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;
      const finalPriceInput = body.final_price;
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (typeof finalPriceInput !== "number" || !Number.isFinite(finalPriceInput) || finalPriceInput < 0) {
        return badRequest("final_price must be a non-negative number");
      }
      if (!reason) return badRequest("reason is required");

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("appointments")
        .select("business_id, status, price, final_price, entitlement_discount, offer_discount")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (fetchErr || !existing) return notFound("Appointment not found");
      const existingRow = existing as Record<string, unknown>;

      const ctx = await requireOwnerManagerOrSupervisorCtx(req, existingRow.business_id as string);
      if (ctx instanceof Response) return ctx;

      const status = existingRow.status as string;
      if (!["confirmed", "in_progress", "pending", "offered", "pending_completion"].includes(status)) {
        return badRequest(`Cannot adjust price for an appointment with status '${status}'`);
      }

      const oldPrice = Number(existingRow.final_price ?? existingRow.price);
      const finalPrice = Math.round(finalPriceInput * 100) / 100;
      const discount = Number(existingRow.entitlement_discount ?? 0) + Number(existingRow.offer_discount ?? 0);

      // A lower final price must never retroactively put the appointment
      // "in credit" — there's no refund/credit flow this can hand off to
      // (see PaymentStep's money-handling note), so reject rather than
      // silently create a phantom overpayment the rest of the app can't
      // represent.
      const { data: priorPaymentRows } = await supabaseAdmin
        .from("payments")
        .select("amount, refund_amount, is_test")
        .eq("appointment_id", id)
        .in("status", ["paid", "partial_refund"]);
      const previouslyReceived = ((priorPaymentRows ?? []) as Array<{ amount: number; refund_amount: number | null; is_test: boolean | null }>)
        .filter((p) => !p.is_test)
        .reduce((sum, p) => sum + Number(p.amount) - Number(p.refund_amount ?? 0), 0);
      if (finalPrice - discount < previouslyReceived - 0.01) {
        return badRequest(
          `New price (${(finalPrice - discount).toFixed(2)} after discount) is less than the ${previouslyReceived.toFixed(2)} already received for this appointment. Refund the difference first, or choose a higher price.`,
        );
      }

      const { data: updated, error: updateErr } = await supabaseAdmin
        .from("appointments")
        .update({
          final_price: finalPrice,
          final_price_adjusted_at: new Date().toISOString(),
          final_price_adjusted_by: ctx.userId,
        })
        .eq("id", id)
        .select(APPT_SELECT)
        .single();

      if (updateErr) return serverError(updateErr.message);

      await supabaseAdmin.from("appointment_price_log").insert({
        business_id: existingRow.business_id as string,
        appointment_id: id,
        actor_user_id: ctx.userId,
        old_price: oldPrice,
        new_price: finalPrice,
        reason,
      });

      return jsonCors(req, normalizePayment(updated as Record<string, unknown>));
    }

    // ── PATCH ?action=save-completion-draft ─────────────────────────────────
    // Persists in-progress "Complete appointment" wizard state with zero
    // operational side effects — no stock/commission/payment mutation, no
    // appointment-status change. Body: { step, payload }. Eligibility
    // mirrors the completion PATCH itself (owner/manager/supervisor, or the
    // staff member assigned to this specific appointment).
    if (method === "PATCH" && action === "save-completion-draft") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;
      const step = typeof body.step === "string" && body.step ? body.step : "payment";
      const payload = (body.payload && typeof body.payload === "object") ? body.payload : {};

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("appointments")
        .select("business_id, status, staff_profile_id")
        .eq("id", id)
        .is("deleted_at", null)
        .single();

      if (fetchErr || !existing) return notFound("Appointment not found");
      const existingRow = existing as { business_id: string; status: string; staff_profile_id: string | null };

      // Same owner/manager/supervisor-or-assigned-staff pattern as the
      // completion PATCH handler below.
      const ownerResult = await requireOwnerManagerOrSupervisorCtx(req, existingRow.business_id);
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
            return forbidden("You can only draft completion for your own appointments");
          }
          ctx = { userId: user.id, businessId: existingRow.business_id, role: "staff" };
        } catch (e) {
          if (e instanceof Response) return e;
          return ownerResult;
        }
      } else {
        ctx = ownerResult;
      }

      if (!["confirmed", "in_progress", "pending", "offered", "pending_completion"].includes(existingRow.status)) {
        return badRequest(`Cannot draft completion for an appointment with status '${existingRow.status}'`);
      }

      const { data: draft, error: draftErr } = await supabaseAdmin
        .from("appointment_completion_drafts")
        .upsert(
          {
            business_id: existingRow.business_id,
            appointment_id: id,
            actor_user_id: ctx.userId,
            step,
            payload,
          },
          { onConflict: "appointment_id" },
        )
        .select("step, payload, updated_at")
        .single();

      if (draftErr) return serverError(draftErr.message);
      return jsonCors(req, draft);
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
      if (existing.status === "cancelled" || existing.status === "completed") {
        return badRequest(`Cannot reschedule a ${existing.status} appointment`);
      }

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

      // Atomic (S58 pattern, same as reschedule-booking/index.ts): re-locks and
      // re-checks the target slot (excluding this appointment's own row) in the
      // same transaction as the write, closing the TOCTOU gap a plain .update()
      // would leave open between reading availability and writing the new slot.
      const { error: updateErr } = await supabaseAdmin.rpc("reschedule_appointment_atomic", {
        p_appointment_id: id,
        p_new_starts_at: startsAt.toISOString(),
        p_new_ends_at: endsAt.toISOString(),
        p_new_staff_id: ex.staff_profile_id ?? null,
      });

      if (updateErr) {
        if (isSlotTakenError(updateErr)) {
          return conflict("SLOT_TAKEN", "The requested slot was just booked by someone else");
        }
        return serverError(updateErr.message);
      }

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
        .select("status, business_id, service_id, staff_profile_id, staff_profile_id_2, price, final_price, commission_split_pct, entitlement_discount, offer_discount")
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
        final_price: number | null;
        commission_split_pct: number | null;
        entitlement_discount: number | null;
        offer_discount: number | null;
      };
      // The price actually being charged: the Step 1 "Edit price" override
      // if one was authorized, else the original booking price. `price`
      // itself is never mutated — see 127_appointment_completion_step1.sql.
      const chargedPrice = existingRow.final_price ?? existingRow.price;
      // What the client actually owes after any entitlement/offer discount —
      // the same formula the frontend's effectivePrice()/PaymentStep use, so
      // the wizard's "balance due" and the amount this handler will actually
      // settle never disagree.
      const amountOwed = Math.max(chargedPrice - Number(existingRow.entitlement_discount ?? 0) - Number(existingRow.offer_discount ?? 0), 0);

      // Owner/manager OR a supervisor OR the assigned staff member may update
      // status (staff portal MS1; supervisors added for cross-staff completion)
      const ownerResult = await requireOwnerManagerOrSupervisorCtx(req, existingRow.business_id);
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

      // A processor (Stripe/PawaPay) payment still `pending` hasn't actually
      // been confirmed by the processor yet — the confirming webhook may
      // simply not have landed. Completing the appointment must not silently
      // stamp it `paid` on the processor's behalf; that requires an explicit
      // manual override so the action stays distinguishable from a real
      // processor confirmation. Checked before any write so a rejected
      // completion never leaves the appointment status changed underneath it.
      //
      // Fetches every payment row for this appointment, not just one: manual
      // bookings already insert a placeholder cash/pending row at booking
      // time (see the POST handler above), and pawapay-payment's own
      // existing-row lookup is scoped to provider='pawapay', so it inserts a
      // *second* row rather than reusing that placeholder. A .maybeSingle()
      // here would error (and silently resolve to null, disabling the guard)
      // the moment both rows exist.
      if (status === "completed") {
        const { data: paymentRows } = await supabaseAdmin
          .from("payments")
          .select("status, stripe_payment_intent_id, provider_deposit_id")
          .eq("appointment_id", id);
        const stillPendingProcessorPayment = (paymentRows ?? []).find((p) => {
          const row = p as Record<string, unknown>;
          return (!!row.stripe_payment_intent_id || !!row.provider_deposit_id) && row.status === "pending";
        });
        if (stillPendingProcessorPayment && !body.confirm_manual_payment) {
          return conflict(
            "PROCESSOR_PAYMENT_PENDING",
            "This appointment has a payment still pending confirmation from the payment processor. Pass confirm_manual_payment to record it as paid manually anyway.",
          );
        }
      }

      // Resolve and validate the amount actually being recorded as received
      // before any write — same reasoning as the processor-pending guard
      // above: a rejected completion must never leave the status already
      // flipped underneath it. There's no overpayment/credit flow (see
      // PaymentStep's money-handling note), so an amount beyond what's
      // actually owed is rejected outright rather than silently accepted.
      let amountToRecord: number | null = null;
      if (status === "completed") {
        amountToRecord = typeof body.amount_received_now === "number" && Number.isFinite(body.amount_received_now)
          ? Math.max(0, body.amount_received_now as number)
          : null;
        if (amountToRecord === null) {
          const { data: draftRow } = await supabaseAdmin
            .from("appointment_completion_drafts")
            .select("payload")
            .eq("appointment_id", id)
            .maybeSingle();
          const draftPayload = (draftRow as { payload: Record<string, unknown> } | null)?.payload;
          const draftAmount = draftPayload?.amount_received_now;
          amountToRecord = typeof draftAmount === "number" && Number.isFinite(draftAmount) ? Math.max(0, draftAmount) : amountOwed;
        }
        amountToRecord = Math.round(amountToRecord * 100) / 100;

        if (amountToRecord > amountOwed + 0.01) {
          return badRequest(
            `Amount received (${amountToRecord.toFixed(2)}) exceeds the ${amountOwed.toFixed(2)} owed for this appointment. KaziOne does not support recording an overpayment.`,
          );
        }
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

      // Freeze the commission rate/amount at the moment an appointment
      // completes — otherwise every ledger read recomputes it fresh from
      // the service's CURRENT rate forever, so editing a commission rate
      // would silently rewrite the computed commission on every historical
      // completed-but-unpaid appointment for that service. This snapshot is
      // independent of (and doesn't change) the existing auto-pay /
      // commission_payment-task computations elsewhere in this handler.
      if (status === "completed" && existingRow.staff_profile_id) {
        const [svcRes, sp1Res, sp2Res] = await Promise.all([
          existingRow.service_id
            ? supabaseAdmin.from("services").select("staff_commission_type, staff_commission_value").eq("id", existingRow.service_id).maybeSingle()
            : Promise.resolve({ data: null }),
          supabaseAdmin.from("staff_profiles").select("commission_rate").eq("id", existingRow.staff_profile_id).maybeSingle(),
          existingRow.staff_profile_id_2
            ? supabaseAdmin.from("staff_profiles").select("commission_rate").eq("id", existingRow.staff_profile_id_2).maybeSingle()
            : Promise.resolve({ data: null }),
        ]);
        const svc = svcRes.data as { staff_commission_type: string | null; staff_commission_value: number | null } | null;
        const sp1 = sp1Res.data as { commission_rate: number | null } | null;
        const sp2 = sp2Res.data as { commission_rate: number | null } | null;
        const commType = svc?.staff_commission_type ?? "none";
        const commValue = Number(svc?.staff_commission_value ?? 0);
        const splitPct = existingRow.commission_split_pct;
        const hasSecondStaff = !!existingRow.staff_profile_id_2;
        const primaryFraction = hasSecondStaff ? (splitPct ?? 50) / 100 : 1;

        updateFields.commission_type_snapshot = commType;
        updateFields.commission_value_snapshot = commType === "none" ? Number(sp1?.commission_rate ?? 0) : commValue;
        updateFields.commission_amount_snapshot = calcCommissionAmount(commType, commValue, Number(sp1?.commission_rate ?? 0), chargedPrice, primaryFraction);
        if (hasSecondStaff) {
          const secondaryFraction = (100 - (splitPct ?? 50)) / 100;
          updateFields.commission_amount_snapshot_2 = calcCommissionAmount(commType, commValue, Number(sp2?.commission_rate ?? 0), chargedPrice, secondaryFraction);
        }
      }

      // Compare-and-swap on the status we read at the top of this handler:
      // the WHERE clause only matches if no other request has already moved
      // this appointment's status since. Two concurrent completion requests
      // that both passed the allowedFromStatuses check above will race here,
      // but Postgres's row-level locking during UPDATE means only one can
      // actually flip the row — the other affects 0 rows, .single() then
      // errors with PGRST116, and we bail out below before running any of
      // the completion side effects (payment settlement, stock deduction,
      // commission tasks), closing the double-completion/double-deduction
      // race without needing to move this whole flow into a locking RPC.
      const { data, error } = await supabaseAdmin
        .from("appointments")
        .update(updateFields)
        .eq("id", id)
        .eq("status", existingRow.status)
        .select(APPT_SELECT)
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          return conflict(
            "ALREADY_TRANSITIONED",
            "This appointment's status was already changed by another request.",
          );
        }
        return serverError(error.message);
      }

      await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: id,
        old_status: (existing as Record<string, unknown>).status,
        new_status: status,
        changed_by: changedBy ?? null,
        reason: reason ?? null,
      });

      // A completion-wizard draft only makes sense while the appointment is
      // still awaiting completion — once it's cancelled, drop it so a stale
      // draft never reappears against appointment data that's since moved
      // on. (The 'completed' case is cleaned up below, after its payload
      // has been read for payment settlement.)
      if (status === "cancelled") {
        await supabaseAdmin.from("appointment_completion_drafts").delete().eq("appointment_id", id);
      }

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
        // Resolved and overpayment-validated above, before the status CAS.
        const amountDue = amountOwed;
        const amountToRecordFinal = amountToRecord as number;

        // A completion-wizard draft only makes sense while completion is
        // still in progress — now that it's actually settled, drop it.
        await supabaseAdmin.from("appointment_completion_drafts").delete().eq("appointment_id", id);

        // Multiple payment rows can legitimately exist for one appointment
        // (see the guard above) — .maybeSingle() would error the moment a
        // second row appears. Prefer an already-paid row (nothing to do),
        // else the processor-linked row (the one a manual override targets),
        // else the most recently created row.
        const { data: paymentRows } = await supabaseAdmin
          .from("payments")
          .select("id, status, method, stripe_payment_intent_id, provider, provider_deposit_id, created_at")
          .eq("appointment_id", id)
          .order("created_at", { ascending: false });
        const rows = (paymentRows ?? []) as Record<string, unknown>[];
        const existingPayment = rows.find((p) => p.status === "paid")
          ?? rows.find((p) => !!p.stripe_payment_intent_id || !!p.provider_deposit_id)
          ?? rows[0]
          ?? null;

        // Use body.payment_method if provided; otherwise fall back to what staff already saved
        const method = paymentMethod ?? (existingPayment as Record<string, unknown> | null)?.method as string ?? "cash";

        if (existingPayment) {
          const pay = existingPayment as Record<string, unknown>;
          // The processor-pending guard already ran (and would have returned
          // a 409) before the appointment status was written above, so by
          // this point either the payment isn't processor-pending or the
          // caller explicitly passed confirm_manual_payment.
          const isProcessorLinked = !!pay.stripe_payment_intent_id || !!pay.provider_deposit_id;
          const settledInFull = amountToRecordFinal >= amountDue;

          if (pay.status !== "paid") {
            const manualOverride = isProcessorLinked && pay.status === "pending";
            await supabaseAdmin
              .from("payments")
              .update({
                amount: amountToRecordFinal > 0 ? amountToRecordFinal : pay.amount,
                status: settledInFull ? "paid" : "pending",
                paid_at: settledInFull ? new Date().toISOString() : null,
                method,
                notes: manualOverride
                  ? `Manually confirmed as paid by ${changedBy ?? "owner"} on completion, overriding a still-pending ${pay.provider ?? "processor"} payment.`
                  : settledInFull
                  ? `Recorded as paid by ${changedBy ?? "owner"} on completion.`
                  : `Partial payment of ${amountToRecordFinal} recorded by ${changedBy ?? "owner"} on completion (${(amountDue - amountToRecordFinal).toFixed(2)} still due).`,
              })
              .eq("id", pay.id as string);
            await supabaseAdmin.from("appointment_status_log").insert({
              appointment_id: id,
              old_status: existingRow.status,
              new_status: status,
              changed_by: changedBy ?? null,
              reason: manualOverride
                ? `Payment manually marked paid (method: ${method}), overriding pending ${pay.provider ?? "processor"} confirmation`
                : settledInFull
                ? `Payment recorded as paid (method: ${method})`
                : `Partial payment recorded (method: ${method}, ${amountToRecordFinal} of ${amountDue})`,
            });
          }
        } else if (amountToRecordFinal > 0) {
          // amount > 0 is a hard DB constraint (chk_payments_amount) — an
          // appointment completed with nothing received yet (balance fully
          // due) legitimately has no payment row to create here.
          const settledInFull = amountToRecordFinal >= amountDue;
          await supabaseAdmin.from("payments").insert({
            business_id: businessIdForPayment,
            appointment_id: id,
            amount: amountToRecordFinal,
            status: settledInFull ? "paid" : "pending",
            method,
            paid_at: settledInFull ? new Date().toISOString() : null,
            notes: settledInFull
              ? `Recorded as paid by ${changedBy ?? "owner"} on completion.`
              : `Partial payment of ${amountToRecordFinal} recorded by ${changedBy ?? "owner"} on completion (${(amountDue - amountToRecordFinal).toFixed(2)} still due).`,
          });
          await supabaseAdmin.from("appointment_status_log").insert({
            appointment_id: id,
            old_status: existingRow.status,
            new_status: status,
            changed_by: changedBy ?? null,
            reason: settledInFull
              ? `Payment recorded as paid (method: ${method})`
              : `Partial payment recorded (method: ${method}, ${amountToRecordFinal} of ${amountDue})`,
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
            // Commission base stays the raw charged price (not discount-
            // adjusted) — matches the commission_amount_snapshot formula
            // above, and the pre-existing policy this auto-pay branch always
            // used. amountDue here is deliberately NOT reused: it's the
            // discount-adjusted balance-due figure for payment settlement,
            // a different concept.
            const commissionAmount = calcCommissionAmount(commType, commValue, staffRate, chargedPrice, 1);
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

          // Fetch the service's own commission config once — same formula
          // used for commission_earned and the auto-pay path, so an amount
          // configured on the service (not just a staff's personal rate)
          // is actually honored here too.
          const { data: svcCommRow } = existingRow.service_id
            ? await supabaseAdmin
                .from("services")
                .select("staff_commission_type, staff_commission_value")
                .eq("id", existingRow.service_id)
                .maybeSingle()
            : { data: null };
          const svcComm = svcCommRow as { staff_commission_type: string | null; staff_commission_value: number | null } | null;
          const splitPct = Number(existingRow.commission_split_pct ?? 100);

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
              if (!spRow) continue;
              displayName = spRow.display_name;
              const isPrimary = staffId === existingRow.staff_profile_id;
              const fraction = isPrimary ? splitPct / 100 : (100 - splitPct) / 100;
              commissionAmount = calcCommissionAmount(
                svcComm?.staff_commission_type,
                Number(svcComm?.staff_commission_value ?? 0),
                Number(spRow.commission_rate ?? 0),
                chargedPrice,
                fraction,
              );
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
