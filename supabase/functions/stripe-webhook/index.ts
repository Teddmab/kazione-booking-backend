import Stripe from "stripe";
import { stripe } from "../_shared/stripe.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import {
  sendEmail,
  bookingConfirmationEmail,
} from "../_shared/resend.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// Stripe webhook — verify signature, process events, always return 200
// ---------------------------------------------------------------------------

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const APP_URL = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";

Deno.serve(withLogging("stripe-webhook", async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    console.error("stripe-webhook: missing stripe-signature header");
    return new Response("Missing signature", { status: 400 });
  }

  // ── Verify signature ───────────────────────────────────────────────────
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error("stripe-webhook: signature verification failed:", err);
    return new Response("Invalid signature", { status: 400 });
  }

  console.log(`stripe-webhook: received ${event.type} [${event.id}]`);

  try {
    switch (event.type) {
      case "payment_intent.succeeded":
        await handlePaymentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      case "payment_intent.payment_failed":
        await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
        break;

      case "charge.refunded":
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;

      default:
        console.log(`stripe-webhook: unhandled event type ${event.type}`);
    }
  } catch (err) {
    // Log but still return 200 to prevent Stripe retries on app-level errors
    console.error(`stripe-webhook: error handling ${event.type}:`, err);
  }

  // Always 200 — Stripe retries on non-2xx
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}));

// ---------------------------------------------------------------------------
// payment_intent.succeeded
// ---------------------------------------------------------------------------

async function handlePaymentSucceeded(pi: Stripe.PaymentIntent) {
  const appointmentId = pi.metadata?.appointment_id;
  const bookingReference = pi.metadata?.booking_reference;
  const businessId = pi.metadata?.business_id;

  if (!appointmentId) {
    console.warn("payment_intent.succeeded: no appointment_id in metadata");
    return;
  }

  // Find the charge ID from the latest charge
  const chargeId =
    typeof pi.latest_charge === "string"
      ? pi.latest_charge
      : pi.latest_charge?.id ?? null;

  // UPDATE payment → paid
  const { error: payErr } = await supabaseAdmin
    .from("payments")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      stripe_charge_id: chargeId,
    })
    .eq("stripe_payment_intent_id", pi.id);

  if (payErr) throw payErr;

  // Get current appointment status before updating
  const { data: appt, error: apptFetchErr } = await supabaseAdmin
    .from("appointments")
    .select("id, status, business_id, client_id, service_id, staff_profile_id, starts_at, price, booking_reference, deposit_amount")
    .eq("id", appointmentId)
    .single();

  if (apptFetchErr || !appt) {
    console.error("payment_intent.succeeded: appointment not found", appointmentId);
    return;
  }

  const oldStatus = appt.status;

  // UPDATE appointment → confirmed
  const { error: confirmErr } = await supabaseAdmin
    .from("appointments")
    .update({ status: "confirmed" })
    .eq("id", appointmentId);

  if (confirmErr) throw confirmErr;

  // INSERT status log
  const { error: logErr } = await supabaseAdmin.from("appointment_status_log").insert({
    appointment_id: appointmentId,
    old_status: oldStatus,
    new_status: "confirmed",
    reason: `Payment succeeded (${pi.id})`,
  });
  if (logErr) throw logErr;

  // ── Send confirmation email ───────────────────────────────────────────
  // Load client, service, staff, business for the email
  const [clientResult, serviceResult, staffResult, businessResult] =
    await Promise.all([
      supabaseAdmin
        .from("clients")
        .select("first_name, email, preferred_locale")
        .eq("id", appt.client_id)
        .single(),
      supabaseAdmin
        .from("services")
        .select("name, currency_code")
        .eq("id", appt.service_id)
        .single(),
      appt.staff_profile_id
        ? supabaseAdmin
            .from("staff_profiles")
            .select("display_name")
            .eq("id", appt.staff_profile_id)
            .single()
        : Promise.resolve({ data: { display_name: "Any available" }, error: null }),
      supabaseAdmin
        .from("businesses")
        .select("name, currency_code")
        .eq("id", appt.business_id)
        .single(),
    ]);

  if (clientResult.data && serviceResult.data && businessResult.data) {
    const cl = clientResult.data;
    const svc = serviceResult.data;
    const staff = staffResult.data!;
    const biz = businessResult.data;
    const curr = svc.currency_code ?? biz.currency_code ?? "EUR";
    const startsAt = new Date(appt.starts_at);
    const locale = cl.preferred_locale ?? "en";

    const emailData = bookingConfirmationEmail(
      {
        clientName: cl.first_name,
        salonName: biz.name,
        serviceName: svc.name,
        staffName: staff.display_name,
        date: startsAt.toISOString().slice(0, 10),
        time: startsAt.toISOString().slice(11, 16),
        reference: appt.booking_reference,
        price: `${curr === "EUR" ? "€" : curr} ${(+appt.price).toFixed(2)}`,
        manageUrl: `${APP_URL}/bookings/${appt.booking_reference}`,
      },
      locale,
    );

    sendEmail(cl.email, emailData.subject, emailData.html).catch((err) =>
      console.error("Email failed (payment_intent.succeeded):", err),
    );
  }

  // ── Insert notification for business owner ─────────────────────────────
  const bid = businessId ?? appt.business_id;
  const { data: ownerMember, error: ownerErr } = await supabaseAdmin
    .from("business_members")
    .select("user_id")
    .eq("business_id", bid)
    .eq("role", "owner")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (ownerErr) throw ownerErr;

  if (ownerMember) {
    const { error: notifErr } = await supabaseAdmin.from("notifications").insert({
      business_id: bid,
      user_id: ownerMember.user_id,
      type: "payment_received",
      title: "Payment Received",
      body: `Payment of ${(pi.amount / 100).toFixed(2)} ${pi.currency.toUpperCase()} received for ${bookingReference ?? appointmentId}`,
      metadata: {
        appointment_id: appointmentId,
        booking_reference: bookingReference,
        amount: pi.amount,
        currency: pi.currency,
      },
    });
    if (notifErr) throw notifErr;
  }

  console.log(`payment_intent.succeeded: confirmed appointment ${appointmentId}`);
}

// ---------------------------------------------------------------------------
// payment_intent.payment_failed
// ---------------------------------------------------------------------------

async function handlePaymentFailed(pi: Stripe.PaymentIntent) {
  const appointmentId = pi.metadata?.appointment_id;
  const bookingReference = pi.metadata?.booking_reference;
  const businessId = pi.metadata?.business_id;

  if (!appointmentId) {
    console.warn("payment_intent.payment_failed: no appointment_id in metadata");
    return;
  }

  // UPDATE payment → failed
  const { error: payErr } = await supabaseAdmin
    .from("payments")
    .update({ status: "failed" })
    .eq("stripe_payment_intent_id", pi.id);

  if (payErr) throw payErr;

  // ── Notify client ─────────────────────────────────────────────────────
  const { data: appt, error: apptErr } = await supabaseAdmin
    .from("appointments")
    .select("client_id, business_id")
    .eq("id", appointmentId)
    .single();
  if (apptErr) throw apptErr;

  if (appt?.client_id) {
    const { data: cl, error: clErr } = await supabaseAdmin
      .from("clients")
      .select("user_id")
      .eq("id", appt.client_id)
      .single();
    if (clErr) throw clErr;

    if (cl?.user_id) {
      const { error: notifErr } = await supabaseAdmin.from("notifications").insert({
        business_id: businessId ?? appt.business_id,
        user_id: cl.user_id,
        type: "payment_failed",
        title: "Payment Failed",
        body: `Your payment for booking ${bookingReference ?? appointmentId} could not be processed. Please try again or use a different payment method.`,
        metadata: {
          appointment_id: appointmentId,
          booking_reference: bookingReference,
        },
      });
      if (notifErr) throw notifErr;
    }
  }

  console.log(`payment_intent.payment_failed: appointment ${appointmentId}`);
}

// ---------------------------------------------------------------------------
// charge.refunded
// ---------------------------------------------------------------------------

async function handleChargeRefunded(charge: Stripe.Charge) {
  const piId =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : charge.payment_intent?.id;

  if (!piId) {
    console.warn("charge.refunded: no payment_intent on charge");
    return;
  }

  // Find payment by stripe_payment_intent_id
  const { data: payment, error: payFetchErr } = await supabaseAdmin
    .from("payments")
    .select("id, appointment_id, amount, business_id")
    .eq("stripe_payment_intent_id", piId)
    .maybeSingle();

  if (payFetchErr || !payment) {
    console.warn("charge.refunded: payment not found for PI", piId);
    return;
  }

  // Determine refund amounts
  const totalRefunded = (charge.amount_refunded ?? 0) / 100;
  const originalAmount = +payment.amount;
  const isFullRefund = totalRefunded >= originalAmount;

  // Get the latest refund ID
  const latestRefund = charge.refunds?.data?.[0];
  const refundId = latestRefund?.id ?? null;

  // UPDATE payment
  const { error: payUpdateErr } = await supabaseAdmin
    .from("payments")
    .update({
      status: isFullRefund ? "refunded" : "partial_refund",
      refund_amount: totalRefunded,
      refunded_at: new Date().toISOString(),
      stripe_refund_id: refundId,
    })
    .eq("id", payment.id);

  if (payUpdateErr) throw payUpdateErr;

  // If full refund → cancel appointment
  if (isFullRefund) {
    const { data: appt, error: apptErr } = await supabaseAdmin
      .from("appointments")
      .select("status")
      .eq("id", payment.appointment_id)
      .single();
    if (apptErr) throw apptErr;

    if (appt && appt.status !== "cancelled") {
      const oldStatus = appt.status;

      const { error: cancelErr } = await supabaseAdmin
        .from("appointments")
        .update({
          status: "cancelled",
          cancellation_reason: "Full refund issued",
          cancelled_at: new Date().toISOString(),
        })
        .eq("id", payment.appointment_id);
      if (cancelErr) throw cancelErr;

      const { error: logErr } = await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: payment.appointment_id,
        old_status: oldStatus,
        new_status: "cancelled",
        reason: `Full refund (${refundId ?? piId})`,
      });
      if (logErr) throw logErr;
    }
  }

  console.log(
    `charge.refunded: ${isFullRefund ? "full" : "partial"} refund of ${totalRefunded} for appointment ${payment.appointment_id}`,
  );
}
