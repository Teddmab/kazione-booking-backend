// ---------------------------------------------------------------------------
// Meta WhatsApp Cloud API utility
// Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/messages
//
// Required env vars:
//   META_WHATSAPP_PHONE_ID      — Phone Number ID from Meta developer console
//   META_WHATSAPP_ACCESS_TOKEN  — Permanent system user token
//
// Free tier: first 1 000 service conversations/month at no cost.
// Uses free-form text messages (valid within a 24-hour customer-initiated window).
// For proactive outreach (reminders, confirmations) use pre-approved templates
// — upgrade this function to type:"template" once your templates are approved.
// ---------------------------------------------------------------------------

const PHONE_ID = Deno.env.get("META_WHATSAPP_PHONE_ID");
const ACCESS_TOKEN = Deno.env.get("META_WHATSAPP_ACCESS_TOKEN");

// WhatsApp requires E.164 without '+'. Strips non-digits; converts 00-prefix.
function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

export async function sendWhatsApp(to: string, text: string): Promise<void> {
  if (!PHONE_ID || !ACCESS_TOKEN) {
    console.warn(
      "[meta-whatsapp] META_WHATSAPP_PHONE_ID or META_WHATSAPP_ACCESS_TOKEN not set — WhatsApp skipped",
    );
    return;
  }

  const phone = normalizePhone(to);
  if (!phone) {
    console.warn("[meta-whatsapp] unparseable phone number — WhatsApp skipped:", to);
    return;
  }

  const res = await fetch(
    `https://graph.facebook.com/v20.0/${PHONE_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body: text },
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`[meta-whatsapp] message to ${phone} failed (${res.status}):`, body);
  }
}
