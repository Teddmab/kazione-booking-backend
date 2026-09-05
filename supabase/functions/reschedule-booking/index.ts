import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors } from "../_shared/cors.ts";
import {
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  serverError,
} from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { verifyAuth } from "../_shared/auth.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import {
  sendEmail,
  bookingRescheduleEmail,
} from "../_shared/resend.ts";
import { issueCancelToken } from "../_shared/bookingCancelToken.ts";
import { sendSms } from "../_shared/messagebird.ts";
import { sendWhatsApp } from "../_shared/meta-whatsapp.ts";
import { isSeatCapacityExceededError, isSlotTakenError } from "../_shared/slotConflict.ts";
import { logSeatCapacityRejection } from "../_shared/seatCapacityLog.ts";
import { localWallClockToUtcIso, utcIsoToLocalParts } from "../_shared/timezone.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RescheduleBody {
  appointment_id?: string;
  booking_reference?: string;
  email?: string;
  new_date: string;
  new_time: string;
  staff_profile_id?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const APP_URL = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("reschedule-booking", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  // ── Rate limit: 10 reschedules per IP per hour ───────────────────────────
  const rateLimited = checkRateLimit(req, 10, 3_600_000);
  if (rateLimited) return rateLimited;

  try {
    const body: RescheduleBody = await req.json();

    // ── Validate input ────────────────────────────────────────────────────
    if (!body.appointment_id && !body.booking_reference) {
      return badRequest("Either appointment_id or booking_reference is required");
    }
    if (!body.new_date || !DATE_RE.test(body.new_date)) {
      return badRequest("new_date is required (YYYY-MM-DD)");
    }
    if (!body.new_time || !TIME_RE.test(body.new_time)) {
      return badRequest("new_time is required (HH:MM)");
    }

    // ── Find appointment ──────────────────────────────────────────────────
    let query = supabaseAdmin
      .from("appointments")
      .select(`
        id, business_id, client_id, staff_profile_id, service_id,
        status, starts_at, ends_at, duration_minutes, price,
        deposit_amount, booking_reference
      `);

    if (body.appointment_id) {
      query = query.eq("id", body.appointment_id);
    } else {
      query = query.eq("booking_reference", body.booking_reference!);
    }

    const { data: appointment, error: apptErr } = await query.maybeSingle();
    if (apptErr) throw apptErr;
    if (!appointment) return notFound("Appointment not found");

    if (appointment.status === "cancelled") {
      return badRequest("Cannot reschedule a cancelled appointment");
    }
    if (appointment.status === "completed") {
      return badRequest("Cannot reschedule a completed appointment");
    }

    // ── Authorize ─────────────────────────────────────────────────────────
    let userId: string | null = null;
    try {
      const user = await verifyAuth(req);
      userId = user.id;
    } catch {
      // Guest path
    }

    if (userId) {
      const { data: clientRow, error: clientErr } = await supabaseAdmin
        .from("clients")
        .select("user_id")
        .eq("id", appointment.client_id)
        .single();
      if (clientErr) throw clientErr;

      const isClient = clientRow?.user_id === userId;

      if (!isClient) {
        const { data: member, error: memberErr } = await supabaseAdmin
          .from("business_members")
          .select("id")
          .eq("business_id", appointment.business_id)
          .eq("user_id", userId)
          .eq("is_active", true)
          .maybeSingle();
        if (memberErr) throw memberErr;

        if (!member) {
          return forbidden("You are not authorized to reschedule this appointment");
        }
      }
    } else {
      if (!body.email) {
        return unauthorized(
          "Authentication or booking email is required to reschedule",
        );
      }

      const { data: clientRow, error: guestErr } = await supabaseAdmin
        .from("clients")
        .select("email")
        .eq("id", appointment.client_id)
        .single();
      if (guestErr) throw guestErr;

      if (
        !clientRow ||
        clientRow.email?.toLowerCase() !== body.email.toLowerCase()
      ) {
        return forbidden("Email does not match the booking");
      }
    }

    // ── Check reschedule policy ───────────────────────────────────────────
    const [settingsResult, bizResult] = await Promise.all([
      supabaseAdmin
        .from("business_settings")
        .select("reschedule_hours")
        .eq("business_id", appointment.business_id)
        .maybeSingle(),
      supabaseAdmin
        .from("businesses")
        .select("timezone")
        .eq("id", appointment.business_id)
        .maybeSingle(),
    ]);
    const settings = settingsResult.data;
    const businessTimezone = bizResult.data?.timezone ?? "UTC";

    const rescheduleHours = settings?.reschedule_hours ?? 24;
    const startsAt = new Date(appointment.starts_at);
    const now = new Date();
    const hoursUntil =
      (startsAt.getTime() - now.getTime()) / (1000 * 60 * 60);

    if (hoursUntil < rescheduleHours) {
      return badRequest(
        `Rescheduling must be done at least ${rescheduleHours} hours before the appointment`,
      );
    }

    // ── Determine staff for new slot ──────────────────────────────────────
    const newStaffId =
      body.staff_profile_id !== undefined
        ? body.staff_profile_id
        : appointment.staff_profile_id;

    // ── Check new slot availability ───────────────────────────────────────
    const { data: availableSlots, error: slotsErr } = await supabaseAdmin.rpc(
      "get_available_slots",
      {
        p_business_id: appointment.business_id,
        p_service_id: appointment.service_id,
        p_staff_id: newStaffId,
        p_date: body.new_date,
      },
    );

    if (slotsErr) throw slotsErr;

    const requestedTime = body.new_time.slice(0, 5);
    const matchingSlots = (availableSlots ?? []).filter(
      (s: { slot_time: string; staff_profile_id: string }) =>
        s.slot_time.slice(0, 5) === requestedTime,
    );

    if (matchingSlots.length === 0) {
      const allTimes = [
        ...new Set(
          (availableSlots ?? []).map((s: { slot_time: string }) =>
            s.slot_time.slice(0, 5)
          ),
        ),
      ] as string[];
      const alternatives = allTimes
        .filter((t) => t > requestedTime)
        .slice(0, 3);

      return conflict("SLOT_TAKEN", "The requested slot is not available", {
        available_alternatives: alternatives,
      });
    }

    // Pick the staff from the matching slot
    const selectedSlot = newStaffId
      ? matchingSlots.find(
          (s: { staff_profile_id: string }) =>
            s.staff_profile_id === newStaffId,
        ) ?? matchingSlots[0]
      : matchingSlots[0];

    const resolvedStaffId = selectedSlot.staff_profile_id;

    // ── Calculate new timestamps ──────────────────────────────────────────
    // new_date/new_time are the business's local wall-clock — convert
    // through the business's IANA timezone to get the true UTC instant.
    const newStartsAt = localWallClockToUtcIso(body.new_date, body.new_time, businessTimezone);
    const newStartsDate = new Date(newStartsAt);
    const newEndsDate = new Date(
      newStartsDate.getTime() + appointment.duration_minutes * 60_000,
    );
    const newEndsAt = newEndsDate.toISOString();

    // ── Update appointment ────────────────────────────────────────────────
    // Atomic (S58): the get_available_slots check above and this write are
    // two separate requests, so a plain .update() here would leave a TOCTOU
    // race window — another booking could land on the same slot in between.
    // reschedule_appointment_atomic re-locks and re-checks the target slot
    // (excluding this appointment's own row) immediately before writing, in
    // the same transaction.
    const oldStatus = appointment.status;
    const { error: updateErr } = await supabaseAdmin.rpc("reschedule_appointment_atomic", {
      p_appointment_id: appointment.id,
      p_new_starts_at: newStartsAt,
      p_new_ends_at: newEndsAt,
      p_new_staff_id: resolvedStaffId,
    });

    if (updateErr) {
      // Public interface — never mention seats/capacity, per the sprint's decision
      // that only the owner-facing appointments endpoint gets the specific reason.
      if (isSeatCapacityExceededError(updateErr)) {
        await logSeatCapacityRejection(updateErr);
        return conflict("SEAT_CAPACITY_EXCEEDED", "This time is no longer available");
      }
      if (isSlotTakenError(updateErr)) {
        return conflict("SLOT_TAKEN", "The requested slot was just booked by someone else");
      }
      console.error("reschedule_appointment_atomic error:", JSON.stringify(updateErr));
      throw updateErr;
    }

    // Update appointment_services timestamps too (fire-and-forget — non-fatal)
    const { error: svcUpdateErr } = await supabaseAdmin
      .from("appointment_services")
      .update({
        starts_at: newStartsAt,
        ends_at: newEndsAt,
        staff_profile_id: resolvedStaffId,
      })
      .eq("appointment_id", appointment.id);
    if (svcUpdateErr) {
      console.error("appointment_services update failed:", svcUpdateErr.message);
    }

    // ── Status log ────────────────────────────────────────────────────────
    await supabaseAdmin.from("appointment_status_log").insert({
      appointment_id: appointment.id,
      old_status: oldStatus,
      new_status: "confirmed",
      changed_by: userId,
      reason: `Rescheduled from ${utcIsoToLocalParts(startsAt.toISOString(), businessTimezone).date} ${utcIsoToLocalParts(startsAt.toISOString(), businessTimezone).time} to ${body.new_date} ${body.new_time}`,
    });

    // ── Send reschedule email ─────────────────────────────────────────────
    const [clientResult, serviceResult, staffResult, businessResult] =
      await Promise.all([
        supabaseAdmin
          .from("clients")
          .select("first_name, email, phone, preferred_locale")
          .eq("id", appointment.client_id)
          .single(),
        supabaseAdmin
          .from("services")
          .select("name, currency_code")
          .eq("id", appointment.service_id)
          .single(),
        resolvedStaffId
          ? supabaseAdmin
              .from("staff_profiles")
              .select("display_name")
              .eq("id", resolvedStaffId)
              .single()
          : Promise.resolve({ data: { display_name: "Any available" }, error: null }),
        supabaseAdmin
          .from("businesses")
          .select("name, currency_code")
          .eq("id", appointment.business_id)
          .single(),
      ]);

    if (clientResult.data && serviceResult.data && businessResult.data) {
      const cl = clientResult.data;
      const svc = serviceResult.data;
      const staff = staffResult.data!;
      const biz = businessResult.data;
      const curr = svc.currency_code ?? biz.currency_code ?? "EUR";
      const locale = cl.preferred_locale ?? "en";
      const cancelToken = await issueCancelToken(appointment.id, appointment.booking_reference);

      const emailData = bookingRescheduleEmail(
        {
          clientName: cl.first_name,
          salonName: biz.name,
          serviceName: svc.name,
          staffName: staff.display_name,
          date: body.new_date,
          time: body.new_time,
          reference: appointment.booking_reference,
          price: `${curr === "EUR" ? "€" : curr} ${(+appointment.price).toFixed(2)}`,
          manageUrl: `${APP_URL}/booking/${appointment.booking_reference}?token=${encodeURIComponent(cancelToken)}`,
        },
        locale,
      );

      if (cl.email) {
        sendEmail(cl.email, emailData.subject, emailData.html).catch((err) =>
          console.error("Reschedule email failed:", err),
        );
      }

      const clientPhone = (cl as unknown as { phone?: string | null }).phone?.trim();
      if (clientPhone) {
        const smsText =
          `${biz.name}: your booking ${appointment.booking_reference} has been rescheduled ` +
          `to ${body.new_date} at ${body.new_time}.`;
        sendSms(clientPhone, smsText).catch((err) =>
          console.error("Reschedule SMS failed:", err),
        );
        sendWhatsApp(clientPhone, smsText).catch((err) =>
          console.error("Reschedule WhatsApp failed:", err),
        );
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        appointment_id: appointment.id,
        booking_reference: appointment.booking_reference,
        new_date: body.new_date,
        new_time: body.new_time,
        staff_profile_id: resolvedStaffId,
        status: "confirmed",
      }),
      {
        status: 200,
        headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("reschedule-booking error:", err);
    return serverError("Failed to reschedule booking");
  }
}));
