import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";

function unprocessableEntity(message: string): Response {
  return new Response(
    JSON.stringify({ error: { code: "VALIDATION_ERROR", message } }),
    { status: 422, headers: { "Content-Type": "application/json" } },
  );
}
import { withLogging } from "../_shared/logger.ts";
import {
  initiateDeposit,
  SUPPORTED_OPERATORS,
  type OperatorCode,
} from "../_shared/pawapay.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PawapayPaymentBody {
  appointmentId: string;
  businessId: string;
  phone: string;
  operatorCode: string;
  amount: string;        // string to avoid float precision issues
  currency: string;      // ISO 4217
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// E.164 phone number: + followed by 7–15 digits
const E164_RE = /^\+[1-9]\d{6,14}$/;

function validateBody(body: PawapayPaymentBody): string | null {
  if (!body.appointmentId) return "appointmentId is required";
  if (!body.businessId) return "businessId is required";
  if (!body.phone) return "phone is required";
  if (!E164_RE.test(body.phone)) {
    return "phone must be in E.164 format (e.g. +256701234567)";
  }
  if (!body.operatorCode) return "operatorCode is required";
  if (!(SUPPORTED_OPERATORS as readonly string[]).includes(body.operatorCode)) {
    return `operatorCode must be one of: ${SUPPORTED_OPERATORS.join(", ")}`;
  }
  if (!body.amount) return "amount is required";
  const amt = parseFloat(body.amount);
  if (isNaN(amt) || amt <= 0) return "amount must be a positive number";
  if (!body.currency) return "currency is required";
  if (body.currency.length !== 3) return "currency must be a 3-letter ISO 4217 code";
  return null;
}

// ---------------------------------------------------------------------------
// Handler — public endpoint (no JWT required)
// ---------------------------------------------------------------------------

Deno.serve(withLogging("pawapay-payment", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  let body: PawapayPaymentBody;
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const validationError = validateBody(body);
  if (validationError) {
    return unprocessableEntity(validationError);
  }

  const { appointmentId, businessId, phone, operatorCode, amount, currency } =
    body;

  try {
    // ── Verify appointment exists and belongs to business ─────────────────
    const { data: appointment, error: apptErr } = await supabaseAdmin
      .from("appointments")
      .select("id, status, business_id")
      .eq("id", appointmentId)
      .eq("business_id", businessId)
      .maybeSingle();

    if (apptErr) throw apptErr;
    if (!appointment) {
      return notFound("Appointment not found");
    }

    // ── Idempotency: don't initiate if already paid/confirmed ─────────────
    const { data: existingPayment } = await supabaseAdmin
      .from("payments")
      .select("id, status, provider_deposit_id")
      .eq("appointment_id", appointmentId)
      .eq("provider", "pawapay")
      .in("status", ["pending", "paid"])
      .maybeSingle();

    if (existingPayment?.status === "paid") {
      return new Response(
        JSON.stringify({
          depositId: existingPayment.provider_deposit_id,
          status: "COMPLETED",
          message: "This appointment has already been paid",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Generate a deterministic deposit ID ───────────────────────────────
    // Re-use existing pending deposit if available; otherwise create new UUID
    let depositId: string;
    if (existingPayment?.provider_deposit_id) {
      depositId = existingPayment.provider_deposit_id;
    } else {
      depositId = crypto.randomUUID();
    }

    // ── Call PawaPay API ──────────────────────────────────────────────────
    const pawapayResponse = await initiateDeposit({
      depositId,
      amount,
      currency,
      phone,
      operatorCode: operatorCode as OperatorCode,
      description: `Booking ${appointmentId.slice(0, 8)}`,
    });

    // ── Store payment record ──────────────────────────────────────────────
    if (!existingPayment) {
      const { error: insertErr } = await supabaseAdmin.from("payments").insert({
        business_id: businessId,
        appointment_id: appointmentId,
        amount: parseFloat(amount),
        currency_code: currency,
        status: "pending",
        method: "mobile_money",
        provider: "pawapay",
        provider_deposit_id: depositId,
      });
      if (insertErr) throw insertErr;
    }

    return new Response(
      JSON.stringify({
        depositId: pawapayResponse.depositId ?? depositId,
        status: "INITIATED",
        message: "Confirm on your phone",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("pawapay-payment error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return serverError(message);
  }
}));
