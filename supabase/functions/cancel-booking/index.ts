import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, unauthorized, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { verifyAuth } from "../_shared/auth.ts";
import { stripe } from "../_shared/stripe.ts";
import { withLogging } from "../_shared/logger.ts";
import {
  sendEmail,
  bookingCancellationEmail,
} from "../_shared/resend.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CancelBody {
  appointment_id?: string;
  booking_reference?: string;
  email?: string;
  reason?: string;
}

const APP_URL = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("cancel-booking", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  try {
    const body: CancelBody = await req.json();

    if (!body.appointment_id && !body.booking_reference) {
      return badRequest("Either appointment_id or booking_reference is required");
    }

    // ── Find appointment ──────────────────────────────────────────────────
    let query = supabaseAdmin
      .from("appointments")
      .select(`
        id, business_id, client_id, staff_profile_id, service_id,
        status, starts_at, ends_at, price, deposit_amount,
        booking_reference, booking_source
      `);

    if (body.appointment_id) {
      query = query.eq("id", body.appointment_id);
    } else {
      query = query.eq("booking_reference", body.booking_reference!);
    }

    const { data: appointment, error: apptErr } = await query.maybeSingle();
    if (apptErr) throw apptErr;
    if (!appointment) return notFound("Appointment not found");

    // Already cancelled?
    if (appointment.status === "cancelled") {
      return badRequest("This appointment is already cancelled");
    }

    // ── Authorize ─────────────────────────────────────────────────────────
    let userId: string | null = null;
    try {
      const user = await verifyAuth(req);
      userId = user.id;
    } catch {
      // Guest path — require email match
    }

    if (userId) {
      // Authenticated: must be the client or a business member
      const { data: clientRow, error: clientErr } = await supabaseAdmin
        .from("clients")
        .select("user_id")
        .eq("id", appointment.client_id)
        .single();
      if (clientErr) throw clientErr;

      const isClient = clientRow?.user_id === userId;

      if (!isClient) {
        // Check business membership
        const { data: member, error: memberErr } = await supabaseAdmin
          .from("business_members")
          .select("id")
          .eq("business_id", appointment.business_id)
          .eq("user_id", userId)
          .eq("is_active", true)
          .maybeSingle();
        if (memberErr) throw memberErr;

        if (!member) {
          return forbidden("You are not authorized to cancel this appointment");
        }
      }
    } else {
      // Guest: must provide matching email
      if (!body.email) {
        return unauthorized(
          "Authentication or booking email is required to cancel",
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

    // ── Fetch business settings for cancellation policy ───────────────────
    const { data: settings, error: settingsErr } = await supabaseAdmin
      .from("business_settings")
      .select("cancellation_hours, stripe_account_id")
      .eq("business_id", appointment.business_id)
      .maybeSingle();
    if (settingsErr) throw settingsErr;

    const cancellationHours = settings?.cancellation_hours ?? 24;
    const stripeAccountId = settings?.stripe_account_id ?? undefined;

    // ── Check cancellation window ─────────────────────────────────────────
    const startsAt = new Date(appointment.starts_at);
    const now = new Date();
    const hoursUntilAppointment =
      (startsAt.getTime() - now.getTime()) / (1000 * 60 * 60);

    const outsideWindow = hoursUntilAppointment >= cancellationHours;

    // ── Handle refund ─────────────────────────────────────────────────────
    const { data: payment, error: paymentErr } = await supabaseAdmin
      .from("payments")
      .select("id, status, amount, stripe_payment_intent_id, currency_code")
      .eq("appointment_id", appointment.id)
      .in("status", ["paid", "pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (paymentErr) throw paymentErr;

    let refundAmount = 0;
    let refundStatus: "full" | "partial" | "none" | "deposit_forfeited" = "none";

    if (payment && payment.status === "paid" && payment.stripe_payment_intent_id) {
      if (outsideWindow) {
        // Full refund
        try {
          const refundOpts: Record<string, unknown> = {
            payment_intent: payment.stripe_payment_intent_id,
          };
          const reqOpts: Record<string, unknown> = {};
          if (stripeAccountId) {
            (reqOpts as { stripeAccount: string }).stripeAccount = stripeAccountId;
          }

          await stripe.refunds.create(
            refundOpts as Parameters<typeof stripe.refunds.create>[0],
            reqOpts as Parameters<typeof stripe.refunds.create>[1],
          );

          refundAmount = +payment.amount;
          refundStatus = "full";

          await supabaseAdmin
            .from("payments")
            .update({
              status: "refunded",
              refund_amount: refundAmount,
              refunded_at: new Date().toISOString(),
            })
            .eq("id", payment.id);
        } catch (err) {
          console.error("Stripe refund failed:", err);
          // Continue with cancellation even if refund fails
          refundStatus = "none";
        }
      } else {
        // Inside window — deposit forfeited
        const depositAmount = +appointment.deposit_amount;
        const paidAmount = +payment.amount;

        if (paidAmount > depositAmount && depositAmount > 0) {
          // Partial refund: refund everything except the deposit
          const partialRefund = paidAmount - depositAmount;
          try {
            const refundOpts: Record<string, unknown> = {
              payment_intent: payment.stripe_payment_intent_id,
              amount: Math.round(partialRefund * 100),
            };
            const reqOpts: Record<string, unknown> = {};
            if (stripeAccountId) {
              (reqOpts as { stripeAccount: string }).stripeAccount = stripeAccountId;
            }

            await stripe.refunds.create(
              refundOpts as Parameters<typeof stripe.refunds.create>[0],
              reqOpts as Parameters<typeof stripe.refunds.create>[1],
            );

            refundAmount = partialRefund;
            refundStatus = "partial";

            await supabaseAdmin
              .from("payments")
              .update({
                status: "partial_refund",
                refund_amount: refundAmount,
                refunded_at: new Date().toISOString(),
              })
              .eq("id", payment.id);
          } catch (err) {
            console.error("Stripe partial refund failed:", err);
            refundStatus = "deposit_forfeited";
          }
        } else {
          // Only deposit was paid — forfeited entirely
          refundStatus = "deposit_forfeited";
        }
      }
    }

    // ── Cancel appointment ────────────────────────────────────────────────
    const oldStatus = appointment.status;

    const { error: cancelErr } = await supabaseAdmin
      .from("appointments")
      .update({
        status: "cancelled",
        cancellation_reason: body.reason ?? "Cancelled by customer",
        cancelled_at: new Date().toISOString(),
        cancelled_by: userId,
      })
      .eq("id", appointment.id);

    if (cancelErr) throw cancelErr;

    // Status log
    const { error: logErr } = await supabaseAdmin.from("appointment_status_log").insert({
      appointment_id: appointment.id,
      old_status: oldStatus,
      new_status: "cancelled",
      changed_by: userId,
      reason: body.reason ?? "Cancelled by customer",
    });
    if (logErr) throw logErr;

    // ── Send cancellation email ───────────────────────────────────────────
    const [clientResult, serviceResult, staffResult, businessResult] =
      await Promise.all([
        supabaseAdmin
          .from("clients")
          .select("first_name, email, preferred_locale")
          .eq("id", appointment.client_id)
          .single(),
        supabaseAdmin
          .from("services")
          .select("name, currency_code")
          .eq("id", appointment.service_id)
          .single(),
        appointment.staff_profile_id
          ? supabaseAdmin
              .from("staff_profiles")
              .select("display_name")
              .eq("id", appointment.staff_profile_id)
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

      const emailData = bookingCancellationEmail(
        {
          clientName: cl.first_name,
          salonName: biz.name,
          serviceName: svc.name,
          staffName: staff.display_name,
          date: startsAt.toISOString().slice(0, 10),
          time: startsAt.toISOString().slice(11, 16),
          reference: appointment.booking_reference,
          price: `${curr === "EUR" ? "€" : curr} ${(+appointment.price).toFixed(2)}`,
          manageUrl: `${APP_URL}/bookings/${appointment.booking_reference}`,
        },
        locale,
      );

      sendEmail(cl.email, emailData.subject, emailData.html).catch((err) =>
        console.error("Cancellation email failed:", err),
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        appointment_id: appointment.id,
        booking_reference: appointment.booking_reference,
        refund_amount: refundAmount,
        refund_status: refundStatus,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("cancel-booking error:", err);
    return serverError("Failed to cancel booking");
  }
}));
