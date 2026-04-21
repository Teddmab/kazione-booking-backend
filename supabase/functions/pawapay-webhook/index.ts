import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { withLogging } from "../_shared/logger.ts";
import { verifyWebhookSignature } from "../_shared/pawapay.ts";
import {
  sendEmail,
  bookingConfirmationEmail,
} from "../_shared/resend.ts";
import { issueCancelToken } from "../_shared/bookingCancelToken.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PawapayWebhookPayload {
  depositId?: string;
  status?: string;      // "COMPLETED" | "FAILED" | "EXPIRED" etc.
  amount?: string;
  currency?: string;
  payer?: { type: string; address: { value: string } };
  correspondent?: string;
  respondedByPayer?: string;
  customerTimestamp?: string;
  // Other fields may be present but are not used
  [key: string]: unknown;
}

const APP_URL = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";

// ---------------------------------------------------------------------------
// Handler — public endpoint, verify_jwt = false in config.toml
// PawaPay retries on non-200, so always return 200 after processing.
// ---------------------------------------------------------------------------

Deno.serve(withLogging("pawapay-webhook", async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-pawapay-signature") ?? "";

  // ── Verify HMAC-SHA256 signature ──────────────────────────────────────
  const isValid = await verifyWebhookSignature(rawBody, signature);
  if (!isValid) {
    console.error("pawapay-webhook: invalid signature");
    return new Response(
      JSON.stringify({ error: { code: "INVALID_SIGNATURE", message: "Signature verification failed" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  let payload: PawapayWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as PawapayWebhookPayload;
  } catch {
    console.error("pawapay-webhook: invalid JSON");
    return new Response("Bad request", { status: 400 });
  }

  const { depositId, status } = payload;

  if (!depositId) {
    console.warn("pawapay-webhook: missing depositId");
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  console.log(`pawapay-webhook: received status=${status} depositId=${depositId}`);

  try {
    if (status === "COMPLETED") {
      await handleCompleted(depositId);
    } else if (status === "FAILED" || status === "EXPIRED") {
      await handleFailed(depositId, status);
    } else {
      console.log(`pawapay-webhook: unhandled status ${status} for depositId=${depositId}`);
    }
  } catch (err) {
    // Log but still return 200 to prevent PawaPay retries on app-level errors
    console.error(`pawapay-webhook: error handling status ${status}:`, err);
  }

  // Always 200 — PawaPay retries on non-2xx
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}));

// ---------------------------------------------------------------------------
// COMPLETED — confirm payment and appointment, send email
// ---------------------------------------------------------------------------

async function handleCompleted(depositId: string) {
  // Find payment record by depositId
  const { data: payment, error: payFindErr } = await supabaseAdmin
    .from("payments")
    .select("id, appointment_id, business_id, status")
    .eq("provider_deposit_id", depositId)
    .eq("provider", "pawapay")
    .maybeSingle();

  if (payFindErr) throw payFindErr;

  if (!payment) {
    console.warn(`pawapay-webhook: no payment found for depositId=${depositId}`);
    return;
  }

  const appointmentId = payment.appointment_id;

  // Get appointment
  const { data: appt, error: apptErr } = await supabaseAdmin
    .from("appointments")
    .select("id, status, business_id, client_id, service_id, staff_profile_id, starts_at, price, booking_reference, deposit_amount")
    .eq("id", appointmentId)
    .single();

  if (apptErr || !appt) {
    console.error(`pawapay-webhook: appointment not found for id=${appointmentId}`);
    return;
  }

  // ── Idempotency guard ─────────────────────────────────────────────────
  if (appt.status === "confirmed" && payment.status === "paid") {
    console.log(`pawapay-webhook: appointment ${appointmentId} already confirmed — duplicate event ignored`);
    return;
  }

  const oldStatus = appt.status;

  // UPDATE payment → paid
  const { error: payUpdateErr } = await supabaseAdmin
    .from("payments")
    .update({
      status: "paid",
      provider: "pawapay",
      paid_at: new Date().toISOString(),
    })
    .eq("id", payment.id);

  if (payUpdateErr) throw payUpdateErr;

  // UPDATE appointment → confirmed
  const { error: confirmErr } = await supabaseAdmin
    .from("appointments")
    .update({ status: "confirmed" })
    .eq("id", appointmentId);

  if (confirmErr) throw confirmErr;

  // INSERT status log
  const { error: logErr } = await supabaseAdmin
    .from("appointment_status_log")
    .insert({
      appointment_id: appointmentId,
      old_status: oldStatus,
      new_status: "confirmed",
      reason: `PawaPay deposit completed (${depositId})`,
    });
  if (logErr) throw logErr;

  // ── Send confirmation email ───────────────────────────────────────────
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
    const staff = staffResult.data ?? { display_name: "Any available" };
    const biz = businessResult.data;
    const curr = svc.currency_code ?? biz.currency_code ?? "EUR";
    const startsAt = new Date(appt.starts_at);
    const locale = (cl.preferred_locale as "en" | "et" | "fr") ?? "en";
    const cancelToken = await issueCancelToken(appt.id, appt.booking_reference);

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
        manageUrl: `${APP_URL}/booking/${appt.booking_reference}?token=${encodeURIComponent(cancelToken)}`,
      },
      locale,
    );

    sendEmail(cl.email, emailData.subject, emailData.html).catch((err) =>
      console.error("Email failed (pawapay-webhook COMPLETED):", err),
    );
  }
}

// ---------------------------------------------------------------------------
// FAILED / EXPIRED — mark payment failed, leave appointment as pending
// ---------------------------------------------------------------------------

async function handleFailed(depositId: string, status: string) {
  const { error: payUpdateErr } = await supabaseAdmin
    .from("payments")
    .update({ status: "failed" })
    .eq("provider_deposit_id", depositId)
    .eq("provider", "pawapay");

  if (payUpdateErr) throw payUpdateErr;

  console.log(`pawapay-webhook: payment marked failed for depositId=${depositId} (status=${status})`);
}
