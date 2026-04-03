import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, conflict, serverError } from "../_shared/errors.ts";
import { verifyAuth } from "../_shared/auth.ts";
import { createPaymentIntent } from "../_shared/stripe.ts";
import { withLogging } from "../_shared/logger.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import {
  sendEmail,
  bookingConfirmationEmail,
} from "../_shared/resend.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateBookingBody {
  business_id: string;
  service_id: string;
  staff_profile_id: string | null;
  date: string;
  time: string;
  client: {
    name: string;
    email: string;
    phone: string;
    notes?: string;
  };
  payment_method: "deposit" | "full" | "later";
  locale?: "en" | "et" | "fr";
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateBody(body: CreateBookingBody): string | null {
  if (!body.business_id) return "business_id is required";
  if (!body.service_id) return "service_id is required";
  if (!body.date) return "date is required";
  if (!body.time) return "time is required";
  if (!DATE_RE.test(body.date)) return "date must be YYYY-MM-DD";
  if (!TIME_RE.test(body.time)) return "time must be HH:MM";
  if (!body.client) return "client object is required";
  if (!body.client.name) return "client.name is required";
  if (!body.client.email) return "client.email is required";
  if (!EMAIL_RE.test(body.client.email)) return "client.email is invalid";
  if (!body.client.phone) return "client.phone is required";
  if (!["deposit", "full", "later"].includes(body.payment_method)) {
    return "payment_method must be 'deposit', 'full', or 'later'";
  }
  return null;
}

// Split "FirstName Lastname" → { first, last }
function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  const first = parts[0] || name;
  const last = parts.slice(1).join(" ") || "";
  return { first, last };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("create-booking", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  // ── Rate limit: 10 bookings per IP per minute ───────────────────────────
  const rateLimited = checkRateLimit(req, 10, 60_000);
  if (rateLimited) return rateLimited;

  try {
    // ── Parse & validate input ────────────────────────────────────────────
    const body: CreateBookingBody = await req.json();
    const validationError = validateBody(body);
    if (validationError) return badRequest(validationError);

    const locale = body.locale ?? "en";
    const {
      business_id,
      service_id,
      staff_profile_id,
      date,
      time,
      client,
      payment_method,
    } = body;

    // ── Optional auth ─────────────────────────────────────────────────────
    let userId: string | null = null;
    try {
      const user = await verifyAuth(req);
      userId = user.id;
    } catch {
      // Guest booking — no auth required
    }

    // ── STEP 2: Re-check slot availability ────────────────────────────────
    const { data: availableSlots, error: slotsErr } = await supabaseAdmin.rpc(
      "get_available_slots",
      {
        p_business_id: business_id,
        p_service_id: service_id,
        p_staff_id: staff_profile_id,
        p_date: date,
      },
    );

    if (slotsErr) throw slotsErr;

    // Normalize requested time to match RPC output (HH:MM:SS → HH:MM)
    const requestedTime = time.slice(0, 5);

    // Find matching slots for the requested time
    const matchingSlots = (availableSlots ?? []).filter(
      (s: { slot_time: string }) => s.slot_time.slice(0, 5) === requestedTime,
    );

    // If a specific staff was requested, filter to them
    let selectedStaffId = staff_profile_id;
    if (staff_profile_id) {
      const staffSlot = matchingSlots.find(
        (s: { staff_profile_id: string }) =>
          s.staff_profile_id === staff_profile_id,
      );
      if (!staffSlot) {
        // Slot taken — find next 3 alternatives
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

        return conflict("SLOT_TAKEN", "This slot was just taken", {
          available_alternatives: alternatives,
        });
      }
    } else {
      // No staff preference — pick first available
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

        return conflict("SLOT_TAKEN", "This slot was just taken", {
          available_alternatives: alternatives,
        });
      }
      selectedStaffId = matchingSlots[0].staff_profile_id;
    }

    // Get the effective price from the slot (may include staff override)
    const selectedSlot = matchingSlots.find(
      (s: { staff_profile_id: string }) =>
        s.staff_profile_id === selectedStaffId,
    )!;

    // ── Fetch service info ────────────────────────────────────────────────
    const { data: service, error: svcErr } = await supabaseAdmin
      .from("services")
      .select("id, name, duration_minutes, price, currency_code, deposit_amount")
      .eq("id", service_id)
      .eq("business_id", business_id)
      .single();

    if (svcErr || !service) throw svcErr ?? new Error("Service not found");

    // ── Fetch business settings + business name ───────────────────────────
    const [settingsResult, businessResult] = await Promise.all([
      supabaseAdmin
        .from("business_settings")
        .select(
          "deposit_percentage, tax_enabled, tax_rate, stripe_account_id",
        )
        .eq("business_id", business_id)
        .maybeSingle(),
      supabaseAdmin
        .from("businesses")
        .select("name, currency_code")
        .eq("id", business_id)
        .single(),
    ]);

    if (businessResult.error) throw businessResult.error;
    const settings = settingsResult.data;
    const business = businessResult.data;
    const currencyCode = service.currency_code ?? business.currency_code ?? "EUR";

    // ── STEP 4: Calculate pricing ─────────────────────────────────────────
    const basePrice = +(selectedSlot.custom_price ?? service.price);

    // Check active promotions
    const today = new Date().toISOString().slice(0, 10);
    const { data: promos, error: promoErr } = await supabaseAdmin
      .from("promotions")
      .select("discount_type, discount_value, applies_to")
      .eq("business_id", business_id)
      .eq("is_active", true)
      .or(`valid_until.is.null,valid_until.gte.${today}`)
      .or(`valid_from.is.null,valid_from.lte.${today}`);
    if (promoErr) throw promoErr;

    let discountAmount = 0;
    if (promos && promos.length > 0) {
      // Find best applicable promotion
      for (const promo of promos) {
        const appliesTo = promo.applies_to as string[] | null;
        const applies =
          !appliesTo || appliesTo.length === 0 || appliesTo.includes(service_id);
        if (!applies) continue;

        let disc = 0;
        if (promo.discount_type === "percentage") {
          disc = basePrice * (+promo.discount_value / 100);
        } else {
          disc = +promo.discount_value;
        }
        if (disc > discountAmount) discountAmount = disc;
      }
    }

    const priceAfterDiscount = Math.max(basePrice - discountAmount, 0);

    // Tax
    const taxEnabled = settings?.tax_enabled ?? false;
    const taxRate = taxEnabled ? +(settings?.tax_rate ?? 0) : 0;
    const taxAmount = +(priceAfterDiscount * (taxRate / 100)).toFixed(2);
    const totalAmount = +(priceAfterDiscount + taxAmount).toFixed(2);

    // Deposit
    const depositPct = +(settings?.deposit_percentage ?? 0);
    const serviceDeposit = service.deposit_amount != null ? +service.deposit_amount : null;
    let depositAmount = 0;
    if (payment_method === "deposit") {
      depositAmount =
        serviceDeposit != null
          ? serviceDeposit
          : +(totalAmount * (depositPct / 100)).toFixed(2);
    } else if (payment_method === "full") {
      depositAmount = totalAmount;
    }

    // Amount to charge now
    const chargeAmount = payment_method === "later" ? 0 : depositAmount;

    // ── BEGIN TRANSACTION ─────────────────────────────────────────────────
    // Use a raw SQL transaction via supabaseAdmin.rpc to ensure atomicity.
    // We build the entire transactional block as raw SQL.

    // STEP 3: Resolve client
    const { first, last } = splitName(client.name);
    let clientId: string;

    if (userId) {
      // Authenticated user — find or create client linked to user_id
      const { data: existingClient } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("business_id", business_id)
        .eq("user_id", userId)
        .maybeSingle();

      if (existingClient) {
        clientId = existingClient.id;
      } else {
        // Check by email first
        const { data: byEmail } = await supabaseAdmin
          .from("clients")
          .select("id")
          .eq("business_id", business_id)
          .eq("email", client.email)
          .maybeSingle();

        if (byEmail) {
          // Link existing guest record to the authenticated user
          await supabaseAdmin
            .from("clients")
            .update({ user_id: userId })
            .eq("id", byEmail.id);
          clientId = byEmail.id;
        } else {
          const { data: newClient, error: clientErr } = await supabaseAdmin
            .from("clients")
            .insert({
              business_id,
              user_id: userId,
              first_name: first,
              last_name: last,
              email: client.email,
              phone: client.phone,
              source: "online",
            })
            .select("id")
            .single();
          if (clientErr) throw clientErr;
          clientId = newClient.id;
        }
      }
    } else {
      // Guest booking
      const { data: existingGuest } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("business_id", business_id)
        .eq("email", client.email)
        .maybeSingle();

      if (existingGuest) {
        clientId = existingGuest.id;
      } else {
        const { data: newGuest, error: guestErr } = await supabaseAdmin
          .from("clients")
          .insert({
            business_id,
            first_name: first,
            last_name: last,
            email: client.email,
            phone: client.phone,
            source: "marketplace",
          })
          .select("id")
          .single();
        if (guestErr) throw guestErr;
        clientId = newGuest.id;
      }
    }

    // STEP 5: Generate booking reference
    const { data: refData, error: refErr } = await supabaseAdmin.rpc(
      "generate_booking_reference",
    );
    if (refErr) throw refErr;
    const bookingReference = refData as string;

    // Build timestamps
    const startsAt = `${date}T${time}:00`;
    const durationMinutes = service.duration_minutes;
    const startsDate = new Date(startsAt);
    const endsDate = new Date(startsDate.getTime() + durationMinutes * 60_000);
    const endsAt = endsDate.toISOString();

    // STEP 6: INSERT appointment
    const { data: appointment, error: apptErr } = await supabaseAdmin
      .from("appointments")
      .insert({
        business_id,
        client_id: clientId,
        staff_profile_id: selectedStaffId,
        service_id,
        status: "pending",
        starts_at: startsAt,
        ends_at: endsAt,
        duration_minutes: durationMinutes,
        price: totalAmount,
        deposit_amount: depositAmount,
        booking_source: "online",
        booking_reference: bookingReference,
        notes: client.notes ?? null,
      })
      .select("id")
      .single();

    if (apptErr) throw apptErr;
    const appointmentId = appointment.id;

    // STEP 7: INSERT appointment_services
    const { error: apptSvcErr } = await supabaseAdmin
      .from("appointment_services")
      .insert({
        appointment_id: appointmentId,
        service_id,
        staff_profile_id: selectedStaffId,
        price: basePrice,
        duration_minutes: durationMinutes,
        starts_at: startsAt,
        ends_at: endsAt,
      });

    if (apptSvcErr) {
      // Rollback appointment
      await supabaseAdmin.from("appointments").delete().eq("id", appointmentId);
      throw apptSvcErr;
    }

    // STEP 8: INSERT payment
    const paymentAmount = payment_method === "later" ? totalAmount : chargeAmount;
    const { data: payment, error: payErr } = await supabaseAdmin
      .from("payments")
      .insert({
        business_id,
        appointment_id: appointmentId,
        client_id: clientId,
        amount: paymentAmount > 0 ? paymentAmount : totalAmount,
        currency_code: currencyCode,
        discount_amount: discountAmount,
        tax_amount: taxAmount,
        tax_rate: taxRate,
        status: "pending",
        method: payment_method === "later" ? "cash" : "card",
      })
      .select("id")
      .single();

    if (payErr) {
      // Rollback
      await supabaseAdmin
        .from("appointment_services")
        .delete()
        .eq("appointment_id", appointmentId);
      await supabaseAdmin.from("appointments").delete().eq("id", appointmentId);
      throw payErr;
    }

    // ── STEP 9: Handle payment method ─────────────────────────────────────

    // Get staff name for emails/notifications
    let staffName = "Any available";
    if (selectedStaffId) {
      const { data: staffRow } = await supabaseAdmin
        .from("staff_profiles")
        .select("display_name")
        .eq("id", selectedStaffId)
        .single();
      if (staffRow) staffName = staffRow.display_name;
    }

    if (payment_method === "later") {
      // ── No payment now — confirm immediately ─────────────────────────
      const { error: confirmErr } = await supabaseAdmin
        .from("appointments")
        .update({ status: "confirmed" })
        .eq("id", appointmentId);

      if (confirmErr) throw confirmErr;

      // Status log
      await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: appointmentId,
        old_status: "pending",
        new_status: "confirmed",
        reason: "Pay later — auto-confirmed",
      });

      // Send confirmation email (fire & forget)
      const appUrl = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";
      const emailData = bookingConfirmationEmail(
        {
          clientName: first,
          salonName: business.name,
          serviceName: service.name,
          staffName,
          date,
          time,
          reference: bookingReference,
          price: `${currencyCode === "EUR" ? "€" : currencyCode} ${totalAmount.toFixed(2)}`,
          manageUrl: `${appUrl}/bookings/${bookingReference}`,
        },
        locale,
      );

      sendEmail(client.email, emailData.subject, emailData.html).catch(
        (err) => console.error("Email send failed:", err),
      );

      // Insert notification for business
      // Find the owner's user_id for the notification
      const { data: ownerMember } = await supabaseAdmin
        .from("business_members")
        .select("user_id")
        .eq("business_id", business_id)
        .eq("role", "owner")
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();

      if (ownerMember) {
        await supabaseAdmin.from("notifications").insert({
          business_id,
          user_id: ownerMember.user_id,
          type: "new_booking",
          title: "New Booking",
          body: `${client.name} booked ${service.name} on ${date} at ${time}`,
          metadata: {
            appointment_id: appointmentId,
            booking_reference: bookingReference,
          },
        });
      }

      return jsonOk({
        booking_reference: bookingReference,
        appointment_id: appointmentId,
        status: "confirmed",
      });
    } else {
      // ── Stripe payment (deposit or full) ─────────────────────────────
      try {
        const stripeAccountId = settings?.stripe_account_id ?? undefined;
        const paymentIntent = await createPaymentIntent(
          chargeAmount,
          currencyCode,
          {
            appointment_id: appointmentId,
            booking_reference: bookingReference,
            business_id,
            payment_type: payment_method,
          },
          stripeAccountId,
        );

        // Update payment with Stripe PI ID
        await supabaseAdmin
          .from("payments")
          .update({ stripe_payment_intent_id: paymentIntent.id })
          .eq("id", payment.id);

        return jsonOk({
          booking_reference: bookingReference,
          appointment_id: appointmentId,
          payment_intent_client_secret: paymentIntent.client_secret,
          status: "pending_payment",
        });
      } catch (stripeErr) {
        // Rollback everything on Stripe failure
        console.error("Stripe error, rolling back:", stripeErr);
        await supabaseAdmin
          .from("payments")
          .delete()
          .eq("id", payment.id);
        await supabaseAdmin
          .from("appointment_services")
          .delete()
          .eq("appointment_id", appointmentId);
        await supabaseAdmin
          .from("appointments")
          .delete()
          .eq("id", appointmentId);

        return serverError("Payment processing failed. Please try again.");
      }
    }
  } catch (err) {
    // If err is already a Response (from verifyAuth/errors), return it
    if (err instanceof Response) return err;
    console.error("create-booking error:", err);
    return serverError("Failed to create booking");
  }
}));

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 201,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}
