import { Resend } from "resend";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError, unauthorized } from "../_shared/errors.ts";
import {
  bookingCancellationEmail,
  bookingConfirmationEmail,
  bookingReminderEmail,
  bookingRescheduleEmail,
  reviewRequestEmail,
  staffInviteEmail,
  staffAppointmentReminderEmail,
  ownerAppointmentReminderEmail,
} from "../_shared/resend.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// Internal auth via x-internal-key header
// ---------------------------------------------------------------------------

// In production this MUST be set via Supabase secrets.
// The fallback is the well-known CI/local-dev value already public in the test file.
const INTERNAL_KEY = Deno.env.get("INTERNAL_FUNCTION_KEY")
  ?? "725b2c7d67955c0eb77589714c9b80879ebf6b157b2d880fa568c0fdeea56fe0";

function verifyInternalKey(req: Request): boolean {
  const key = req.headers.get("x-internal-key");
  if (!key || !INTERNAL_KEY) return false;

  // Constant-time comparison
  const a = new TextEncoder().encode(key);
  const b = new TextEncoder().encode(INTERNAL_KEY);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Resend client (direct, not via shared — this function IS the email service)
// ---------------------------------------------------------------------------

const DEFAULT_FROM = Deno.env.get("BUSINESS_EMAIL_FROM") ??
  "KaziOne Booking <onboarding@resend.dev>";

// ---------------------------------------------------------------------------
// Template types
// ---------------------------------------------------------------------------

type TemplateName =
  | "booking_confirmation"
  | "booking_reminder"
  | "booking_cancellation"
  | "booking_reschedule"
  | "staff_invite"
  | "review_request"
  | "staff_appointment_reminder"
  | "owner_appointment_reminder";

interface SendEmailBody {
  to: string;
  template: TemplateName;
  data: Record<string, string>;
  locale?: "en" | "et" | "fr";
}

const VALID_TEMPLATES: TemplateName[] = [
  "booking_confirmation",
  "booking_reminder",
  "booking_cancellation",
  "booking_reschedule",
  "staff_invite",
  "review_request",
  "staff_appointment_reminder",
  "owner_appointment_reminder",
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("send-email", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  // ── Internal auth ───────────────────────────────────────────────────────
  if (!verifyInternalKey(req)) {
    return unauthorized("Invalid or missing internal key");
  }

  try {
    const body: SendEmailBody = await req.json();

    // ── Validate ──────────────────────────────────────────────────────────
    if (!body.to) return badRequest("'to' email is required");
    if (!body.template) return badRequest("'template' is required");
    if (!VALID_TEMPLATES.includes(body.template)) {
      return badRequest(
        `Invalid template. Must be one of: ${VALID_TEMPLATES.join(", ")}`,
      );
    }
    if (!body.data || typeof body.data !== "object") {
      return badRequest("'data' object is required");
    }

    const locale = body.locale ?? "en";

    // ── Build email from template ─────────────────────────────────────────
    let subject: string;
    let html: string;

    switch (body.template) {
      case "booking_confirmation": {
        const result = bookingConfirmationEmail(
          {
            clientName: body.data.clientName ?? "",
            salonName: body.data.salonName ?? "",
            salonLogoUrl: body.data.salonLogoUrl || undefined,
            serviceName: body.data.serviceName ?? "",
            staffName: body.data.staffName ?? "",
            date: body.data.date ?? "",
            time: body.data.time ?? "",
            reference: body.data.reference ?? "",
            price: body.data.price ?? "",
            manageUrl: body.data.manageUrl ?? "",
          },
          locale,
        );
        subject = result.subject;
        html = result.html;
        break;
      }

      case "booking_reminder": {
        const result = bookingReminderEmail(
          {
            clientName: body.data.clientName ?? "",
            salonName: body.data.salonName ?? "",
            salonLogoUrl: body.data.salonLogoUrl || undefined,
            serviceName: body.data.serviceName ?? "",
            staffName: body.data.staffName ?? "",
            date: body.data.date ?? "",
            time: body.data.time ?? "",
            reference: body.data.reference ?? "",
            price: body.data.price ?? "",
            manageUrl: body.data.manageUrl ?? "",
          },
          locale,
        );
        subject = result.subject;
        html = result.html;
        break;
      }

      case "booking_cancellation": {
        const result = bookingCancellationEmail(
          {
            clientName: body.data.clientName ?? "",
            salonName: body.data.salonName ?? "",
            salonLogoUrl: body.data.salonLogoUrl || undefined,
            serviceName: body.data.serviceName ?? "",
            staffName: body.data.staffName ?? "",
            date: body.data.date ?? "",
            time: body.data.time ?? "",
            reference: body.data.reference ?? "",
            price: body.data.price ?? "",
            manageUrl: body.data.manageUrl ?? "",
          },
          locale,
        );
        subject = result.subject;
        html = result.html;
        break;
      }

      case "booking_reschedule": {
        const result = bookingRescheduleEmail(
          {
            clientName: body.data.clientName ?? "",
            salonName: body.data.salonName ?? "",
            salonLogoUrl: body.data.salonLogoUrl || undefined,
            serviceName: body.data.serviceName ?? "",
            staffName: body.data.staffName ?? "",
            date: body.data.date ?? "",
            time: body.data.time ?? "",
            reference: body.data.reference ?? "",
            price: body.data.price ?? "",
            manageUrl: body.data.manageUrl ?? "",
          },
          locale,
        );
        subject = result.subject;
        html = result.html;
        break;
      }

      case "staff_invite": {
        const result = staffInviteEmail(
          {
            salonName: body.data.salonName ?? "",
            salonLogoUrl: body.data.salonLogoUrl || undefined,
            inviterName: body.data.inviterName ?? "",
            acceptUrl: body.data.acceptUrl ?? "",
          },
          locale,
        );
        subject = result.subject;
        html = result.html;
        break;
      }

      case "review_request": {
        const result = reviewRequestEmail(
          {
            clientName: body.data.clientName ?? "",
            salonName: body.data.salonName ?? "",
            salonLogoUrl: body.data.salonLogoUrl || undefined,
            serviceName: body.data.serviceName ?? "",
            reviewUrl: body.data.reviewUrl ?? "",
          },
          locale,
        );
        subject = result.subject;
        html = result.html;
        break;
      }

      case "staff_appointment_reminder": {
        const result = staffAppointmentReminderEmail({
          staffName: body.data.staffName ?? "",
          salonName: body.data.salonName ?? "",
          salonLogoUrl: body.data.salonLogoUrl || undefined,
          clientName: body.data.clientName ?? "",
          serviceName: body.data.serviceName ?? "",
          date: body.data.date ?? "",
          time: body.data.time ?? "",
          reference: body.data.reference ?? "",
        });
        subject = result.subject;
        html = result.html;
        break;
      }

      case "owner_appointment_reminder": {
        const result = ownerAppointmentReminderEmail({
          salonName: body.data.salonName ?? "",
          salonLogoUrl: body.data.salonLogoUrl || undefined,
          clientName: body.data.clientName ?? "",
          clientEmail: body.data.clientEmail || null,
          clientPhone: body.data.clientPhone || null,
          serviceName: body.data.serviceName ?? "",
          staffName: body.data.staffName ?? "",
          date: body.data.date ?? "",
          time: body.data.time ?? "",
          reference: body.data.reference ?? "",
          manageUrl: body.data.manageUrl ?? "",
        });
        subject = result.subject;
        html = result.html;
        break;
      }
    }

    // ── Send via Resend ───────────────────────────────────────────────────
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      return serverError("RESEND_API_KEY not configured");
    }
    const resend = new Resend(resendApiKey);
    const { data: emailResult, error: emailErr } = await resend.emails.send({
      from: DEFAULT_FROM,
      to: body.to,
      subject,
      html,
    });

    if (emailErr) {
      console.error("send-email: Resend error:", emailErr);
      return serverError(`Email delivery failed: ${JSON.stringify(emailErr)}`);
    }

    return new Response(
      JSON.stringify({
        sent: true,
        message_id: emailResult?.id ?? null,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("send-email error:", err);
    return serverError("Failed to send email");
  }
}));
