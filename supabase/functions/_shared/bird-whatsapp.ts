// ---------------------------------------------------------------------------
// Bird WhatsApp utility (via @messagebird/sdk)
// Docs: https://developers.bird.com/api/whatsapp
//
// Required env vars:
//   BIRD_API_KEY                    — API key from Bird.com dashboard (bk_eu1_…)
//   BIRD_WA_REMINDER_TEMPLATE       — approved template name for client reminders
//                                     (default: "kazione_appointment_reminder")
//   BIRD_WA_STAFF_REMINDER_TEMPLATE — approved template name for staff reminders
//                                     (default: "kazione_staff_reminder")
//
// IMPORTANT: WhatsApp Business API only allows pre-approved templates for
// proactive outreach. Templates must be created in Bird.com → WhatsApp →
// Templates and approved by Meta before they can be sent.
// ---------------------------------------------------------------------------

// deno-lint-ignore-file no-explicit-any
import { BirdClient } from "@messagebird/sdk";

const API_KEY = Deno.env.get("BIRD_API_KEY");

function getClient(): any | null {
  if (!API_KEY) return null;
  try {
    return new BirdClient({ apiKey: API_KEY });
  } catch {
    return null;
  }
}

// E.164 format with '+' (Bird SDK expects this)
function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

export interface WhatsAppSendResult {
  ok: boolean;
  /** Bird's own message id, when the SDK response includes one. */
  messageId?: string | null;
  /** Set when ok is false — config/validation issue or an SDK-thrown error. */
  error?: string;
}

async function sendTemplate(
  to: string,
  templateName: string,
  bodyParams: string[],
): Promise<WhatsAppSendResult> {
  const client = getClient();
  if (!client) {
    console.warn("[bird-wa] BIRD_API_KEY not set — WhatsApp skipped");
    return { ok: false, error: "BIRD_API_KEY not configured" };
  }

  const phone = normalizePhone(to);
  if (!phone) {
    console.warn("[bird-wa] unparseable phone number — WhatsApp skipped:", to);
    return { ok: false, error: "Unparseable phone number" };
  }

  try {
    const result = await client.whatsapp.send({
      to: phone,
      template: {
        name: templateName,
        components: [
          {
            type: "body",
            parameters: bodyParams.map((text) => ({ type: "text", text })),
          },
        ],
      },
    });
    return { ok: true, messageId: result?.id ?? null };
  } catch (err) {
    console.error(`[bird-wa] template "${templateName}" to ${phone} failed:`, err);
    return { ok: false, error: err instanceof Error ? err.message : "Bird WhatsApp send failed" };
  }
}

// ---------------------------------------------------------------------------
// Client appointment reminder
// Template variables: {{1}} clientName, {{2}} serviceName, {{3}} salonName,
//                     {{4}} date, {{5}} time
// ---------------------------------------------------------------------------
export async function sendClientWaReminder(
  to: string,
  params: {
    clientName: string;
    serviceName: string;
    salonName: string;
    date: string;
    time: string;
  },
): Promise<WhatsAppSendResult> {
  const template = Deno.env.get("BIRD_WA_REMINDER_TEMPLATE") ?? "kazione_appointment_reminder";
  return await sendTemplate(to, template, [
    params.clientName,
    params.serviceName,
    params.salonName,
    params.date,
    params.time,
  ]);
}

// ---------------------------------------------------------------------------
// Staff appointment reminder
// Template variables: {{1}} staffName, {{2}} clientName, {{3}} serviceName,
//                     {{4}} date, {{5}} time
// ---------------------------------------------------------------------------
export async function sendStaffWaReminder(
  to: string,
  params: {
    staffName: string;
    clientName: string;
    serviceName: string;
    date: string;
    time: string;
  },
): Promise<WhatsAppSendResult> {
  const template = Deno.env.get("BIRD_WA_STAFF_REMINDER_TEMPLATE") ?? "kazione_staff_reminder";
  return await sendTemplate(to, template, [
    params.staffName,
    params.clientName,
    params.serviceName,
    params.date,
    params.time,
  ]);
}
