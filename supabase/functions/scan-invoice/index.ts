import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface ScannedItem {
  product_name: string;
  sku: string | null;
  quantity: number;
  unit_price: number;
}

interface ScanResult {
  supplier_hint: string | null;
  supplier_type_hint: string | null;
  items: ScannedItem[];
  raw_total: number | null;
}

async function callClaudeVision(imageUrl: string): Promise<ScanResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const prompt = `You are analyzing a supplier invoice or receipt image for a beauty/hair salon business.

Extract the following information and respond ONLY with valid JSON:

{
  "supplier_hint": "supplier or company name from the invoice, or null if not visible",
  "supplier_type_hint": "one of: product | rent | utility | service | other — infer from what is being purchased",
  "items": [
    {
      "product_name": "exact product name from invoice",
      "sku": "SKU/reference code if visible, otherwise null",
      "quantity": 1,
      "unit_price": 0.00
    }
  ],
  "raw_total": 0.00
}

Rules:
- quantity must be a positive number (default 1 if not clear)
- unit_price must be a positive number in the invoice currency (default 0 if not clear)
- Include ALL line items visible on the invoice
- product_name should be the full name as written on the invoice
- supplier_type_hint: use "product" for physical goods/materials, "rent" for rental/lease, "utility" for electricity/water/internet/phone, "service" for professional services, "other" for anything else
- Do NOT include taxes/VAT as a separate line item
- Respond ONLY with the JSON object, no other text`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "url",
                url: imageUrl,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const text = (data.content?.[0]?.text ?? "").trim();

  // Extract JSON — strip markdown code fences if present
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : text;

  try {
    return JSON.parse(jsonStr) as ScanResult;
  } catch {
    throw new Error(`Failed to parse Claude response as JSON: ${jsonStr.slice(0, 200)}`);
  }
}

/**
 * POST /scan-invoice
 *
 * Body: { business_id, image_url }
 *
 * Returns:
 *   { supplier_hint, supplier_type_hint, items, raw_total,
 *     matched_supplier: { id, name } | null }
 *
 * Resolves supplier_hint against existing suppliers for this business.
 * Does NOT create anything — caller decides what to create/link.
 */
Deno.serve(withLogging("scan-invoice", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } }, 405);
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const { business_id, image_url } = body;

    if (!business_id || typeof business_id !== "string") return badRequest("business_id is required");
    if (!image_url || typeof image_url !== "string") return badRequest("image_url is required");

    const ctx = await requireOwnerOrManagerCtx(req, business_id);
    if (ctx instanceof Response) return ctx;

    // Parse invoice with Claude vision
    const scanned = await callClaudeVision(image_url);

    // Try to match supplier_hint against existing suppliers for this business
    let matchedSupplier: { id: string; name: string } | null = null;
    if (scanned.supplier_hint) {
      const hint = scanned.supplier_hint.toLowerCase().trim();
      const { data: suppliers } = await supabaseAdmin
        .from("suppliers")
        .select("id, name")
        .eq("business_id", business_id)
        .eq("is_active", true);

      if (suppliers) {
        const match = (suppliers as { id: string; name: string }[]).find(
          (s) =>
            s.name.toLowerCase().includes(hint) ||
            hint.includes(s.name.toLowerCase()),
        );
        if (match) matchedSupplier = match;
      }
    }

    return json({
      supplier_hint: scanned.supplier_hint,
      supplier_type_hint: scanned.supplier_type_hint ?? "product",
      items: scanned.items ?? [],
      raw_total: scanned.raw_total,
      matched_supplier: matchedSupplier,
    });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("scan-invoice error:", e);
    return serverError((e as Error).message ?? "Failed to scan invoice");
  }
}));
