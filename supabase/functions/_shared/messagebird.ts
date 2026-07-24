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

export async function sendSms(to: string, body: string): Promise<void> {
  if (!API_KEY) {
    console.warn("[messagebird] MESSAGEBIRD_API_KEY not set — SMS skipped");
    return;
  }

  const phone = normalizePhone(to);
  if (!phone) {
    console.warn("[messagebird] unparseable phone number — SMS skipped:", to);
    return;
  }

  const res = await fetch("https://rest.messagebird.com/messages", {
    method: "POST",
    headers: {
      Authorization: `AccessKey ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ originator: FROM, recipients: [phone], body }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[messagebird] SMS to ${phone} failed (${res.status}):`, text);
  }
}
