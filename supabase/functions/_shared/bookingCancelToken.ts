interface CancelTokenPayload {
  aid: string;
  br: string;
  exp: number;
}

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(data: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(signature);
}

function getSecret(): string {
  return (
    Deno.env.get("BOOKING_CANCEL_TOKEN_SECRET") ??
    Deno.env.get("SUPABASE_JWT_SECRET") ??
    "local-dev-cancel-token-secret"
  );
}

export async function issueCancelToken(
  appointmentId: string,
  bookingReference: string,
  expiresInDays = 30,
): Promise<string> {
  const payload: CancelTokenPayload = {
    aid: appointmentId,
    br: bookingReference,
    exp: Math.floor(Date.now() / 1000) + expiresInDays * 24 * 60 * 60,
  };

  const payloadStr = JSON.stringify(payload);
  const payloadPart = encodeURIComponent(payloadStr);
  const sigPart = toHex(await sign(payloadPart, getSecret()));
  return `${payloadPart}.${sigPart}`;
}

export async function verifyCancelToken(token: string): Promise<CancelTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadPart, sigPart] = parts;
  const expectedSig = toHex(await sign(payloadPart, getSecret()));
  if (sigPart !== expectedSig) return null;

  try {
    const payloadStr = decodeURIComponent(payloadPart);
    const payload = JSON.parse(payloadStr) as CancelTokenPayload;

    if (!payload?.aid || !payload?.br || !payload?.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}
