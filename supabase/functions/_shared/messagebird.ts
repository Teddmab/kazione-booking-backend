// ---------------------------------------------------------------------------
// MessageBird (Bird) SMS utility
// Docs: https://developers.messagebird.com/api/sms-messaging/
//
// Required env vars:
//   MESSAGEBIRD_API_KEY  — access key from MessageBird dashboard
//   MESSAGEBIRD_FROM     — sender ID or E.164 number (default: "KaziOne")
// ---------------------------------------------------------------------------

const API_KEY = Deno.env.get("MESSAGEBIRD_API_KEY");
const FROM = Deno.env.get("MESSAGEBIRD_FROM") ?? "KaziOne";

// Strips all non-digit characters. MessageBird REST API expects MSISDN without '+'.
function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  // Convert 00-prefix international numbers (e.g. 00358…) to plain digits
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

export interface SmsSendResult {
  ok: boolean;
  /** MessageBird's own message id, when available. */
  messageId?: string | null;
  /** Set when ok is false — config/validation issue or a non-2xx API response. */
  error?: string;
}

export async function sendSms(to: string, body: string): Promise<SmsSendResult> {
  if (!API_KEY) {
    console.warn("[messagebird] MESSAGEBIRD_API_KEY not set — SMS skipped");
    return { ok: false, error: "MESSAGEBIRD_API_KEY not configured" };
  }

  const phone = normalizePhone(to);
  if (!phone) {
    console.warn("[messagebird] unparseable phone number — SMS skipped:", to);
    return { ok: false, error: "Unparseable phone number" };
  }

  try {
    const res = await fetch("https://rest.messagebird.com/messages", {
      method: "POST",
      headers: {
        Authorization: `AccessKey ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ originator: FROM, recipients: [phone], body }),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`[messagebird] SMS to ${phone} failed (${res.status}):`, text);
      return { ok: false, error: `MessageBird ${res.status}: ${text}` };
    }

    let messageId: string | null = null;
    try {
      messageId = (JSON.parse(text) as { id?: string })?.id ?? null;
    } catch {
      // Non-JSON success body — unexpected but not fatal, just no id to report.
    }
    return { ok: true, messageId };
  } catch (err) {
    console.error(`[messagebird] SMS to ${phone} request failed:`, err);
    return { ok: false, error: err instanceof Error ? err.message : "MessageBird request failed" };
  }
}
