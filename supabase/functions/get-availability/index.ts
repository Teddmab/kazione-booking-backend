import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

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
  service: ServiceInfo;
  slots: Slot[];
  isAvailable: boolean;
  reason?: string;
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

    const requestedDate = new Date(dateStr! + "T00:00:00Z");
    if (isNaN(requestedDate.getTime())) {
      return badRequest("Invalid date value.");
    }

    // 2. Validate date range — must be today or future
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (requestedDate < today) {
      return jsonOk({
        date: dateStr!,
        dayName: DAY_NAMES[requestedDate.getUTCDay()],
        service: null,
        slots: [],
        isAvailable: false,
        reason: "DATE_IN_PAST",
      });
    }

    // Check booking_future_days from business_settings
    const { data: settings, error: settingsErr } = await supabaseAdmin
      .from("business_settings")
      .select("booking_future_days")
      .eq("business_id", businessId!)
      .maybeSingle();
    if (settingsErr) throw settingsErr;

    const futureDays = settings?.booking_future_days ?? 60;
    const maxDate = new Date(today);
    maxDate.setUTCDate(maxDate.getUTCDate() + futureDays);

    if (requestedDate > maxDate) {
      return jsonOk({
        date: dateStr!,
        dayName: DAY_NAMES[requestedDate.getUTCDay()],
        service: null,
        slots: [],
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

    // 3. Call get_available_slots RPC
    const { data: rawSlots, error: rpcErr } = await supabaseAdmin.rpc(
      "get_available_slots",
      {
        p_business_id: businessId!,
        p_service_id: serviceId!,
        p_staff_id: staffId,
        p_date: dateStr!,
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
    const slotMap = new Map<string, SlotStaff[]>();
    for (const row of rawSlots ?? []) {
      const time = (row.slot_time as string).slice(0, 5); // "HH:MM"
      if (!slotMap.has(time)) slotMap.set(time, []);
      slotMap.get(time)!.push({
        id: row.staff_profile_id,
        name: row.staff_name,
        avatarUrl: avatarMap[row.staff_profile_id] ?? null,
        price: +(row.custom_price ?? service.price),
      });
    }

    const slots: Slot[] = Array.from(slotMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([time, staff]) => ({ time, staff }));

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
      isAvailable: slots.length > 0,
      ...(reason ? { reason } : {}),
    };

    return jsonOk(response);
  } catch (err) {
    console.error("get-availability error:", err);
    return serverError("Failed to fetch availability");
  }
}));

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=30",
    },
  });
}
