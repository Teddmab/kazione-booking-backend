// ---------------------------------------------------------------------------
// _shared/pawapay.ts — PawaPay API client helper
// ---------------------------------------------------------------------------
// Environment variables required:
//   PAWAPAY_API_KEY        — bearer token for PawaPay API
//   PAWAPAY_WEBHOOK_SECRET — hex secret used to verify HMAC-SHA256 signatures
//   PAWAPAY_ENV            — "sandbox" (default) | "production"
// ---------------------------------------------------------------------------

const PAWAPAY_ENV = Deno.env.get("PAWAPAY_ENV") ?? "sandbox";

const BASE_URLS: Record<string, string> = {
  sandbox: "https://api.sandbox.pawapay.io",
  production: "https://api.pawapay.io",
};

export const PAWAPAY_BASE_URL =
  BASE_URLS[PAWAPAY_ENV] ?? BASE_URLS["sandbox"];

// ---------------------------------------------------------------------------
// Supported operator codes
// ---------------------------------------------------------------------------

export const SUPPORTED_OPERATORS = [
  "MTN_MOMO_UGA",
  "MTN_MOMO_GHA",
  "MTN_MOMO_ZMB",
  "AIRTEL_OAPI_UGA",
  "ORANGE_SEN",
  "ORANGE_CIV",
  "FREE_SEN",
  "VODACOM_TZA",
  "MPESA_KEN",
  "TIGO_TZA",
  "HALOTEL_TZA",
  "ZAMTEL_ZMB",
] as const;

export type OperatorCode = typeof SUPPORTED_OPERATORS[number];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InitiateDepositParams {
  depositId: string;       // UUID — your idempotency key
  amount: string;          // string e.g. "25.00"
  currency: string;        // ISO 4217 e.g. "UGX"
  phone: string;           // E.164 e.g. "+256701234567"
  operatorCode: OperatorCode;
  description: string;
}

export interface PawapayDepositResponse {
  depositId: string;
  status: string;          // "INITIATED" | "COMPLETED" | "FAILED" | etc.
  created?: string;
  depositedAmount?: string;
  currency?: string;
  correspondent?: string;
  payer?: { type: string; address: { value: string } };
  statementDescription?: string;
  customerTimestamp?: string;
  receivedByRecipient?: string;
  respondedByPayer?: string;
}

// ---------------------------------------------------------------------------
// initiateDeposit
// ---------------------------------------------------------------------------

export async function initiateDeposit(
  params: InitiateDepositParams,
): Promise<PawapayDepositResponse> {
  const apiKey = Deno.env.get("PAWAPAY_API_KEY");
  if (!apiKey) {
    throw new Error("PAWAPAY_API_KEY is not configured");
  }

  const url = `${PAWAPAY_BASE_URL}/deposits`;

  const body = {
    depositId: params.depositId,
    amount: params.amount,
    currency: params.currency,
    correspondent: params.operatorCode,
    payer: {
      type: "MSISDN",
      address: { value: params.phone },
    },
    customerTimestamp: new Date().toISOString(),
    statementDescription: params.description.slice(0, 22), // max 22 chars
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await response.json() as PawapayDepositResponse;

  if (!response.ok) {
    throw new Error(
      `PawaPay API error ${response.status}: ${JSON.stringify(data)}`,
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// Pawapay signs webhook POSTs with HMAC-SHA256 over the raw body.
// Signature is in the "x-pawapay-signature" header (hex-encoded).
// ---------------------------------------------------------------------------

export async function verifyWebhookSignature(
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const secret = Deno.env.get("PAWAPAY_WEBHOOK_SECRET");
  if (!secret) {
    console.warn("PAWAPAY_WEBHOOK_SECRET not configured — skipping signature check");
    return false;
  }

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(rawBody);

  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, messageData);
  const expectedHex = Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expectedHex.length !== signature.length) return false;
  const a = new TextEncoder().encode(expectedHex);
  const b = new TextEncoder().encode(signature);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
