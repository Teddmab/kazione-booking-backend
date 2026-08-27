import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { localDateRangeToUtcIso, localWallClockToUtcIso, utcIsoToLocalParts } from "../_shared/timezone.ts";

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

interface SlotStaff {
  id: string;
  name: string;
  avatarUrl: string | null;
  price: number;
}

interface Slot {
  time: string;
  staff: SlotStaff[];
}

interface ServiceInfo {
  id: string;
  name: string;
  durationMinutes: number;
  price: number;
}

interface AvailabilityResponse {
  date: string;
  dayName: string;
  service: ServiceInfo | null;
  slots: Slot[];
  reserved_slots: string[];
  isAvailable: boolean;
  reason?: string;
}

interface FallbackStaffRow {
  id: string;
  display_name: string;
  avatar_url?: string | null;
  custom_price?: number | string | null;
}

interface FallbackWorkingHourRow {
  staff_profile_id: string;
  start_time: string | null;
  end_time: string | null;
  is_working: boolean;
}

interface FallbackAppointmentRow {
  staff_profile_id?: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
}

interface FallbackTimeOffRow {
  staff_profile_id: string;
  starts_at: string;
  ends_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("get-availability", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET") {
    return badRequest("Only GET is allowed");
  }

  try {
    const url = new URL(req.url);
    const businessId = url.searchParams.get("business_id");
    const serviceId = url.searchParams.get("service_id");
    const dateStr = url.searchParams.get("date");
    const staffId = url.searchParams.get("staff_id") || null;
    const requestPaymentMethod =
      (url.searchParams.get("payment_method") as "deposit" | "full" | "later" | null) ??
      "later";

    // 1. Validate required params
    const missing: string[] = [];
    if (!businessId) missing.push("business_id");
    if (!serviceId) missing.push("service_id");
    if (!dateStr) missing.push("date");
    if (missing.length > 0) {
      return badRequest(
        `Missing required query parameter(s): ${missing.join(", ")}`,
      );
    }

    if (!DATE_RE.test(dateStr!)) {
      return badRequest("Invalid date format. Expected YYYY-MM-DD.");
    }

    if (!["deposit", "full", "later"].includes(requestPaymentMethod)) {
      return badRequest("Invalid payment_method. Expected deposit, full, or later.");
    }

    const requestedDate = new Date(dateStr! + "T00:00:00Z");
    if (isNaN(requestedDate.getTime())) {
      return badRequest("Invalid date value.");
    }

    // Check booking_future_days + privacy flags from business_settings, and
    // the business's IANA timezone — every date-boundary check below is
    // relative to the business's local "today", not UTC "today" (S59).
    const [settingsResult, businessResult] = await Promise.all([
      supabaseAdmin
        .from("business_settings")
        .select("booking_future_days, hide_staff_names")
        .eq("business_id", businessId!)
        .maybeSingle(),
      supabaseAdmin
        .from("businesses")
        .select("timezone")
        .eq("id", businessId!)
        .maybeSingle(),
    ]);
    if (settingsResult.error) throw settingsResult.error;
    if (businessResult.error) throw businessResult.error;
    const settings = settingsResult.data;
    const businessTimezone = businessResult.data?.timezone ?? "UTC";

    // 2. Validate date range — must be today or future, in the business's
    // local calendar. YYYY-MM-DD strings compare correctly lexicographically,
    // sidestepping Date-object timezone ambiguity entirely.
    const todayLocal = utcIsoToLocalParts(new Date().toISOString(), businessTimezone).date;
    if (dateStr! < todayLocal) {
      return jsonOk(req, {
        date: dateStr!,
        dayName: DAY_NAMES[requestedDate.getUTCDay()],
        service: null,
        slots: [],
        reserved_slots: [],
        isAvailable: false,
        reason: "DATE_IN_PAST",
      });
    }

    const futureDays = settings?.booking_future_days ?? 60;
    const maxDateLocal = new Date(todayLocal + "T00:00:00Z");
    maxDateLocal.setUTCDate(maxDateLocal.getUTCDate() + futureDays);
    const maxDateLocalStr = maxDateLocal.toISOString().slice(0, 10);

    if (dateStr! > maxDateLocalStr) {
      return jsonOk(req, {
        date: dateStr!,
        dayName: DAY_NAMES[requestedDate.getUTCDay()],
        service: null,
        slots: [],
        reserved_slots: [],
        isAvailable: false,
        reason: "OUTSIDE_BOOKING_WINDOW",
      });
    }

    // 4. Fetch service info (with optional staff custom price)
    const { data: service, error: svcErr } = await supabaseAdmin
      .from("services")
      .select("id, name, duration_minutes, price")
      .eq("id", serviceId!)
      .eq("business_id", businessId!)
      .eq("is_active", true)
      .maybeSingle();

    if (svcErr) throw svcErr;
    if (!service) {
      return badRequest("Service not found or inactive.");
    }

    const serviceInfo: ServiceInfo = {
      id: service.id,
      name: service.name,
      durationMinutes: service.duration_minutes,
      price: +service.price,
    };

    // If a specific staff was requested, use their custom price if set
    if (staffId) {
      const { data: staffSvc, error: staffSvcErr } = await supabaseAdmin
        .from("staff_services")
        .select("custom_price")
        .eq("staff_profile_id", staffId)
        .eq("service_id", serviceId!)
        .maybeSingle();
      if (staffSvcErr) throw staffSvcErr;

      if (staffSvc?.custom_price != null) {
        serviceInfo.price = +staffSvc.custom_price;
      }
    }

    // 3. Try the RPC first; fall back to a direct working-hours-based implementation
    // if the database function is missing or errors on this environment.
    let slots: Slot[] = [];
    try {
      const { data: rawSlots, error: rpcErr } = await supabaseAdmin.rpc(
        "get_available_slots",
        {
          p_business_id: businessId!,
          p_service_id: serviceId!,
          p_staff_id: staffId ?? null,
          p_date: dateStr!,
          p_min_staff: 1,
        },
      );

      if (rpcErr) throw rpcErr;

      // Fetch avatar URLs for all returned staff
      const staffIds = [
        ...new Set(
          (rawSlots ?? []).map(
            (s: { staff_profile_id: string }) => s.staff_profile_id,
          ),
        ),
      ] as string[];

      let avatarMap: Record<string, string | null> = {};
      if (staffIds.length > 0) {
        const { data: profiles, error: profilesErr } = await supabaseAdmin
          .from("staff_profiles")
          .select("id, avatar_url")
          .in("id", staffIds);
        if (profilesErr) throw profilesErr;

        if (profiles) {
          avatarMap = Object.fromEntries(
            profiles.map((p: { id: string; avatar_url: string | null }) => [
              p.id,
              p.avatar_url,
            ]),
          );
        }
      }

      // 5. Group by slot_time
      const hideNames = settings?.hide_staff_names === true;
      const slotMap = new Map<string, SlotStaff[]>();
      for (const row of rawSlots ?? []) {
        const time = (row.slot_time as string).slice(0, 5); // "HH:MM"
        if (!slotMap.has(time)) slotMap.set(time, []);
        slotMap.get(time)!.push({
          id: row.staff_profile_id,
          name: hideNames ? "Professional" : row.staff_name,
          avatarUrl: hideNames ? null : (avatarMap[row.staff_profile_id] ?? null),
          price: +(row.custom_price ?? service.price),
        });
      }

      slots = Array.from(slotMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([time, staff]) => ({ time, staff }));
    } catch (rpcErr) {
      console.warn("get_available_slots RPC failed, using fallback availability generation", rpcErr);
      const dayOfWeek = requestedDate.getUTCDay();

      // Eligibility must mirror get_available_slots (migration 126): only
      // staff with an ACCEPTED offer for this service, and only once their
      // effective_date (if any) has arrived — this fallback previously
      // ignored staff_services entirely and showed every active staff
      // member of the business for any service, ready or not.
      const { data: staffServices, error: staffServicesErr } = await supabaseAdmin
        .from("staff_services")
        .select("staff_profile_id, custom_price, effective_date")
        .eq("service_id", serviceId!)
        .eq("status", "accepted");
      if (staffServicesErr) throw staffServicesErr;

      const eligibleStaffIds = (staffServices ?? [])
        .filter((s) => !s.effective_date || s.effective_date <= dateStr!)
        .map((s) => s.staff_profile_id as string);

      let staffProfiles: { id: string; display_name: string; avatar_url: string | null }[] = [];
      if (eligibleStaffIds.length > 0) {
        const { data: profiles, error: staffProfilesErr } = await supabaseAdmin
          .from("staff_profiles")
          .select("id, display_name, avatar_url")
          .eq("business_id", businessId!)
          .eq("is_active", true)
          .in("id", eligibleStaffIds);
        if (staffProfilesErr) throw staffProfilesErr;
        staffProfiles = profiles ?? [];
      }

      const { data: workingHoursRows, error: workingHoursErr } = await supabaseAdmin
        .from("staff_working_hours")
        .select("staff_profile_id, start_time, end_time, is_working")
        .eq("business_id", businessId!)
        .eq("day_of_week", dayOfWeek)
        .eq("is_working", true);
      if (workingHoursErr) throw workingHoursErr;

      const { startUtcIso: dayStart, endUtcIsoExclusive: nextDayString } =
        localDateRangeToUtcIso(dateStr!, businessTimezone);
      const { data: appointments, error: appointmentsErr } = await supabaseAdmin
        .from("appointments")
        .select("staff_profile_id, starts_at, ends_at, status")
        .eq("business_id", businessId!)
        .gte("starts_at", dayStart)
        .lt("starts_at", nextDayString);
      if (appointmentsErr) throw appointmentsErr;

      const { data: timeOffRows, error: timeOffErr } = await supabaseAdmin
        .from("staff_time_off")
        .select("staff_profile_id, starts_at, ends_at")
        .eq("business_id", businessId!);
      if (timeOffErr) throw timeOffErr;

      slots = buildFallbackAvailability({
        dateStr: dateStr!,
        requestedDate,
        businessTimezone,
        durationMinutes: service.duration_minutes,
        slotIntervalMinutes: 30,
        leadHours: 2,
        serviceInfo,
        staffRows: (staffProfiles ?? []).map((row: FallbackStaffRow) => ({
          id: row.id,
          display_name: row.display_name,
          avatar_url: row.avatar_url ?? null,
          custom_price: (staffServices ?? []).find((svc) => svc.staff_profile_id === row.id)?.custom_price ?? null,
        })),
        workingHoursRows: (workingHoursRows ?? []) as FallbackWorkingHourRow[],
        appointmentRows: (appointments ?? []) as FallbackAppointmentRow[],
        timeOffRows: (timeOffRows ?? []) as FallbackTimeOffRow[],
        hideStaffNames: settings?.hide_staff_names === true,
        requestedStaffId: staffId,
      }).slots;
    }

    // Highlight reserved starts for the date so UI can show occupied times.
    const { startUtcIso: reservedDayStart, endUtcIsoExclusive: reservedDayEnd } =
      localDateRangeToUtcIso(dateStr!, businessTimezone);
    let reservedSlots: string[] = [];

    try {
      const { data: appointmentRows, error: appointmentsErr } = await supabaseAdmin
        .from("appointments")
        .select("id, starts_at, status")
        .eq("business_id", businessId!)
        .gte("starts_at", reservedDayStart)
        .lt("starts_at", reservedDayEnd)
        .not("status", "in", "(cancelled,no_show)");

      if (appointmentsErr) throw appointmentsErr;

      const appointmentIds = (appointmentRows ?? []).map((row: { id: string }) => row.id);

      let paymentMap = new Map<string, { method: string | null; status: string | null }>();
      if (appointmentIds.length > 0) {
        const { data: paymentRows, error: paymentsErr } = await supabaseAdmin
          .from("payments")
          .select("appointment_id, method, status")
          .in("appointment_id", appointmentIds);

        if (paymentsErr) throw paymentsErr;

        paymentMap = new Map(
          (paymentRows ?? []).map((row: {
            appointment_id: string;
            method: string | null;
            status: string | null;
          }) => [
            row.appointment_id,
            { method: row.method, status: row.status },
          ]),
        );
      }

      // reserved_slots = times that have a PENDING booking (someone is mid-booking but hasn't paid).
      // Confirmed/paid slots are already absent from the available slots grid (staff is blocked).
      // This lets the UI show "in demand" indicators on truly bookable times so clients
      // know to pre-pay to secure the slot — the first to complete payment wins.
      reservedSlots = [...new Set((appointmentRows ?? [])
        .filter((row: { id: string; status: string }) => {
          const payment = paymentMap.get(row.id) ?? null;
          const payStatus = payment?.status ?? null;
          return (
            row.status === "pending" ||
            row.status === "pending_payment" ||
            payStatus === "pending"
          );
        })
        .map((row: { starts_at: string }) => utcIsoToLocalParts(row.starts_at, businessTimezone).time))]
        .sort((a, b) => a.localeCompare(b));
    } catch (reservedErr) {
      console.error("reserved slots query failed:", reservedErr);
    }

    // 7. Determine reason if no slots
    let reason: string | undefined;
    if (slots.length === 0) {
      // Check if a working day for any staff
      const dayOfWeek = requestedDate.getUTCDay();
      const { data: workingRows } = await supabaseAdmin
        .from("staff_working_hours")
        .select("is_working")
        .eq("business_id", businessId!)
        .eq("day_of_week", dayOfWeek)
        .eq("is_working", true);

      if (!workingRows || workingRows.length === 0) {
        reason = "DAY_OFF";
      } else {
        reason = "FULLY_BOOKED";
      }
    }

    // 8. Build response
    const response: AvailabilityResponse = {
      date: dateStr!,
      dayName: DAY_NAMES[requestedDate.getUTCDay()],
      service: serviceInfo,
      slots,
      reserved_slots: reservedSlots,
      isAvailable: slots.length > 0,
      ...(reason ? { reason } : {}),
    };

    return jsonOk(req, response);
  } catch (err) {
    console.error("get-availability error:", err);
    return serverError("Failed to fetch availability");
  }
}));

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

export function buildFallbackAvailability(input: {
  dateStr: string;
  requestedDate: Date;
  businessTimezone: string;
  durationMinutes: number;
  slotIntervalMinutes: number;
  leadHours: number;
  serviceInfo: ServiceInfo;
  staffRows: FallbackStaffRow[];
  workingHoursRows: FallbackWorkingHourRow[];
  appointmentRows: FallbackAppointmentRow[];
  timeOffRows: FallbackTimeOffRow[];
  hideStaffNames: boolean;
  requestedStaffId: string | null;
}): AvailabilityResponse {
  const { dateStr, businessTimezone, serviceInfo, staffRows, workingHoursRows, appointmentRows, timeOffRows, hideStaffNames, requestedStaffId } = input;
  const slotMap = new Map<string, SlotStaff[]>();
  const eligibleStaff = (staffRows ?? []).filter((staff) => {
    if (requestedStaffId && staff.id !== requestedStaffId) return false;
    return true;
  });

  const slotIntervalMinutes = input.slotIntervalMinutes ?? 30;
  const durationMinutes = input.durationMinutes ?? serviceInfo.durationMinutes;
  const { startUtcIso, endUtcIsoExclusive } = localDateRangeToUtcIso(dateStr, businessTimezone);
  const startOfDay = new Date(startUtcIso);
  const endOfDay = new Date(endUtcIsoExclusive);

  for (const staff of eligibleStaff) {
    const hours = (workingHoursRows ?? []).find(
      (row) => row.staff_profile_id === staff.id && row.is_working,
    );
    if (!hours?.start_time || !hours?.end_time) continue;

    const startMinutes = parseHHMM(hours.start_time);
    const endMinutes = parseHHMM(hours.end_time);
    if (startMinutes < 0 || endMinutes < 0 || endMinutes <= startMinutes) continue;

    for (let slotStart = startMinutes; slotStart + durationMinutes <= endMinutes; slotStart += slotIntervalMinutes) {
      const slotTime = formatHHMM(slotStart);
      const slotStartTime = new Date(localWallClockToUtcIso(dateStr, slotTime, businessTimezone));
      const slotEndTime = new Date(slotStartTime.getTime() + durationMinutes * 60_000);

      const overlapsAppointment = (appointmentRows ?? []).some((row) => {
        if (!row.staff_profile_id || row.staff_profile_id !== staff.id) return false;
        if (["cancelled", "no_show"].includes(row.status)) return false;
        const startsAt = new Date(row.starts_at);
        const endsAt = new Date(row.ends_at);
        return slotStartTime < endsAt && slotEndTime > startsAt;
      });
      if (overlapsAppointment) continue;

      const overlapsTimeOff = (timeOffRows ?? []).some((row) => {
        if (row.staff_profile_id !== staff.id) return false;
        const startsAt = new Date(row.starts_at);
        const endsAt = new Date(row.ends_at);
        return slotStartTime < endsAt && slotEndTime > startsAt;
      });
      if (overlapsTimeOff) continue;

      const now = new Date();
      if (slotStartTime < now) continue;
      if (slotStartTime < new Date(now.getTime() + input.leadHours * 60 * 60 * 1000)) continue;
      if (slotStartTime < startOfDay || slotStartTime >= endOfDay) continue;

      const existing = slotMap.get(slotTime) ?? [];
      existing.push({
        id: staff.id,
        name: hideStaffNames ? "Professional" : staff.display_name,
        avatarUrl: hideStaffNames ? null : (staff.avatar_url ?? null),
        price: +(staff.custom_price ?? serviceInfo.price),
      });
      slotMap.set(slotTime, existing);
    }
  }

  const slots: Slot[] = Array.from(slotMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([time, staff]) => ({ time, staff }));

  return {
    date: dateStr,
    dayName: DAY_NAMES[input.requestedDate.getUTCDay()],
    service: serviceInfo,
    slots,
    reserved_slots: [],
    isAvailable: slots.length > 0,
  };
}

function parseHHMM(value: string | null): number {
  if (!value) return -1;
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return -1;
  return hours * 60 + minutes;
}

function formatHHMM(value: number): string {
  const hours = Math.floor(value / 60).toString().padStart(2, "0");
  const minutes = (value % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

function jsonOk(req: Request, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...corsHeadersFor(req),
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
    },
  });
}
