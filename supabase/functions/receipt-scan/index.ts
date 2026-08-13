import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { findCandidates, type OcrData } from "./match.ts";

/**
 * /receipt-scan — Claude Vision OCR + smart matching
 *
 * POST   body: { business_id, image_base64, image_type? }
 *   → Uploads to storage, calls Claude Vision, runs matching
 *   → Returns { receipt_id, ocr, candidates }
 *
 * PATCH  ?id=&action=confirm
 *   body: { matched_to, matched_id?, expense? }
 *   → Updates receipts row; creates/updates expense record
 *   → Returns { success: true, expense_id? }
 */
Deno.serve(withLogging("receipt-scan", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");
  const id     = url.searchParams.get("id");

  try {
    // ── POST — scan image ──────────────────────────────────────────────────
    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      const imageBase64 = body.image_base64 as string | undefined;
      const imageType   = (body.image_type as string | undefined) ?? "image/jpeg";

      if (!imageBase64) return badRequest("image_base64 is required");

      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string | undefined);
      if (ctx instanceof Response) return ctx;

      // Upload to Supabase Storage
      const fileExt    = imageType.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
      const storagePath = `${ctx.businessId}/${crypto.randomUUID()}.${fileExt}`;

      const imageBytes = Uint8Array.from(atob(imageBase64), (c) => c.charCodeAt(0));

      const { error: uploadErr } = await supabaseAdmin
        .storage
        .from("receipts")
        .upload(storagePath, imageBytes, { contentType: imageType, upsert: false });

      if (uploadErr) {
        console.warn("receipt upload error:", uploadErr.message);
        return serverError("Failed to upload receipt image");
      }

      // Call Claude Vision API
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) {
        console.error("ANTHROPIC_API_KEY not set");
        return serverError("OCR service not configured");
      }

      let ocr: OcrData = {
        amount: null, currency: null, date: null,
        merchant_name: null, tax_amount: null, line_items: [],
      };

      try {
        const visionResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-opus-5",
            max_tokens: 512,
            messages: [{
              role: "user",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: imageType, data: imageBase64 },
                },
                {
                  type: "text",
                  text: `Extract from this receipt and return ONLY valid JSON (no markdown, no explanation):
{
  "amount": <total amount as number, not string>,
  "currency": "<ISO 4217 code, e.g. EUR>",
  "date": "<YYYY-MM-DD>",
  "merchant_name": "<business name>",
  "tax_amount": <tax amount as number or null>,
  "line_items": [{"description": "<item>", "amount": <number>}]
}
If a field cannot be determined, use null. If no line items, use [].`,
                },
              ],
            }],
          }),
        });

        if (visionResp.ok) {
          const visionJson = await visionResp.json() as Record<string, unknown>;
          const content = (visionJson.content as Array<{ type: string; text: string }>)?.[0];
          if (content?.type === "text") {
            try {
              const parsed = JSON.parse(content.text.trim()) as Partial<OcrData>;
              ocr = {
                amount:        typeof parsed.amount === "number" ? parsed.amount : null,
                currency:      typeof parsed.currency === "string" ? parsed.currency : null,
                date:          typeof parsed.date === "string" ? parsed.date : null,
                merchant_name: typeof parsed.merchant_name === "string" ? parsed.merchant_name : null,
                tax_amount:    typeof parsed.tax_amount === "number" ? parsed.tax_amount : null,
                line_items:    Array.isArray(parsed.line_items) ? parsed.line_items : [],
              };
            } catch {
              console.warn("receipt-scan: failed to parse Claude response:", content.text);
            }
          }
        } else {
          console.warn("Claude Vision API error:", visionResp.status, await visionResp.text());
        }
      } catch (visionErr) {
        console.warn("Claude Vision fetch error:", visionErr);
      }

      // Insert receipts audit row
      const { data: receiptRow, error: insertErr } = await supabaseAdmin
        .from("receipts")
        .insert({
          business_id:  ctx.businessId,
          owner_id:     ctx.userId,
          storage_path: storagePath,
          ocr_data:     ocr,
        })
        .select("id")
        .single();

      if (insertErr) return serverError("Failed to save receipt record");

      // Smart match candidates
      const candidates = await findCandidates(ctx.businessId, ocr);

      return jsonCors(req, {
        receipt_id: (receiptRow as { id: string }).id,
        ocr,
        candidates,
      });
    }

    // ── PATCH ?action=confirm ──────────────────────────────────────────────
    if (method === "PATCH" && action === "confirm") {
      if (!id) return badRequest("id is required");

      const body = await req.json() as Record<string, unknown>;
      const matchedTo  = body.matched_to as string | undefined;
      const matchedId  = body.matched_id as string | undefined;
      const expenseIn  = body.expense as Record<string, unknown> | undefined;

      if (!matchedTo || !["appointment", "expense", "unknown"].includes(matchedTo)) {
        return badRequest("matched_to must be 'appointment', 'expense', or 'unknown'");
      }

      // Fetch receipt to get business_id + ocr_data
      const { data: receipt } = await supabaseAdmin
        .from("receipts")
        .select("business_id, ocr_data, storage_path")
        .eq("id", id)
        .maybeSingle();

      if (!receipt) return notFound("Receipt not found");
      const r = receipt as { business_id: string; ocr_data: OcrData; storage_path: string };

      const ctx = await requireOwnerOrManagerCtx(req, r.business_id);
      if (ctx instanceof Response) return ctx;

      let expenseId: string | null = null;

      if (matchedTo === "expense" && matchedId) {
        // Link existing expense to this receipt
        await supabaseAdmin
          .from("expenses")
          .update({ receipt_url: r.storage_path, ocr_data: r.ocr_data })
          .eq("id", matchedId)
          .eq("business_id", ctx.businessId);
        expenseId = matchedId;

      } else if (matchedTo === "appointment" || matchedTo === "unknown") {
        // Create a new expense entry
        const ocr = r.ocr_data;
        const amount      = expenseIn?.amount      ?? ocr.amount      ?? 0;
        const date        = expenseIn?.date        ?? ocr.date        ?? new Date().toISOString().slice(0, 10);
        const description = expenseIn?.description ?? ocr.merchant_name ?? "Receipt expense";
        const category    = expenseIn?.category    ?? "other";

        const newExpense: Record<string, unknown> = {
          business_id:  ctx.businessId,
          category,
          description,
          amount,
          currency_code: ocr.currency ?? "EUR",
          tax_amount:    ocr.tax_amount ?? 0,
          date,
          receipt_url:   r.storage_path,
          ocr_data:      r.ocr_data,
        };

        if (matchedTo === "appointment" && matchedId) {
          newExpense.appointment_id = matchedId;
        }

        const { data: created, error: expErr } = await supabaseAdmin
          .from("expenses")
          .insert(newExpense)
          .select("id")
          .single();

        if (expErr) {
          console.error("expense insert error:", expErr.message);
          return serverError("Failed to create expense record");
        }

        expenseId = (created as { id: string }).id;
      }

      // Update receipt match status
      await supabaseAdmin
        .from("receipts")
        .update({
          matched_to: matchedTo,
          matched_id: matchedId ?? expenseId ?? null,
        })
        .eq("id", id);

      return jsonCors(req, { success: true, expense_id: expenseId });
    }

    return badRequest("Method not allowed");
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("receipt-scan error:", e);
    return serverError("Unexpected error");
  }
}));
