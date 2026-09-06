import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";
import { logServiceActivity } from "../_shared/serviceActivity.ts";

/**
 * /products — product catalog CRUD + stock management + service-product usage
 *
 * GET  ?business_id=                          → product list with is_low_stock flag
 * GET  ?id=                                   → single product + last 20 stock movements
 * GET  ?action=service-usage&service_id=      → products used by a service
 * GET  ?action=recent-movements&business_id=  → recent stock movements, all products
 * GET  ?action=scan-photos&product_id=        → a product's saved scan photos (signed URLs)
 * POST                body={business_id,...}  → create product
 * POST ?action=service-usage                  → link product to service
 * POST ?action=scan   body={business_id,images:[{base64,media_type,kind}]}
 *                                              → AI-extract product details from 1-3 photos;
 *                                                saves the photos regardless of outcome
 * PATCH ?id=          body={...fields}        → update product fields
 * PATCH ?action=adjust&id=                    → manual stock adjustment
 * PATCH ?action=deactivate&id=               → soft-delete product
 * PATCH ?action=service-usage&id=            → update a service-product link's quantity
 * DELETE ?action=service-usage&id=           → remove service-product link
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

type Confidence = "high" | "medium" | "low";

interface ScannedProductResult {
  name: string | null;
  brand: string | null;
  category: string | null;
  colour: string | null;
  size_label: string | null;
  unit: string | null;
  barcode: string | null;
  confidence: Partial<Record<"name" | "brand" | "category" | "colour" | "size_label" | "barcode", Confidence>>;
}

// Reads 1-3 product photos (front label / barcode / ingredients) in one
// Claude Vision call and extracts structured catalogue fields, each with a
// confidence level so the owner knows what to double-check before saving.
async function callClaudeVisionForProduct(
  images: { media_type: string; data: string }[],
): Promise<ScannedProductResult> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const prompt = `You are analyzing 1-3 photos of a single beauty/hair-salon retail product (front label, barcode close-up, and/or ingredients/back label) to catalogue it for inventory.

Extract the following and respond ONLY with valid JSON, no other text:

{
  "name": "full product name as printed, or null if not legible",
  "brand": "brand name, or null",
  "category": "a short category like 'Hair extensions', 'Shampoo & Care', 'Styling', 'Nail Polish', or null if unclear",
  "colour": "colour/shade if shown (e.g. '1B Natural Black'), or null",
  "size_label": "net quantity as printed (e.g. '100 g', '250 ml'), or null",
  "unit": "one of: piece | ml | g | kg | L | bottle | box | pack | roll — your best guess for how this product is stocked",
  "barcode": "the EAN/UPC barcode digits if a barcode is visible and legible, or null",
  "confidence": {
    "name": "high" | "medium" | "low",
    "brand": "high" | "medium" | "low",
    "category": "high" | "medium" | "low",
    "colour": "high" | "medium" | "low",
    "size_label": "high" | "medium" | "low",
    "barcode": "high" | "medium" | "low"
  }
}

Rules:
- Only include a confidence entry for a field if you set a non-null value for it.
- "high" = printed clearly and unambiguously, "medium" = partially legible or inferred, "low" = a guess.
- Do not invent a barcode — only report digits you can actually read.
- Respond ONLY with the JSON object.`;

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
            ...images.map((img) => ({
              type: "image",
              source: { type: "base64", media_type: img.media_type, data: img.data },
            })),
            { type: "text", text: prompt },
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
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : text;

  try {
    return JSON.parse(jsonStr) as ScannedProductResult;
  } catch {
    throw new Error(`Failed to parse Claude response as JSON: ${jsonStr.slice(0, 200)}`);
  }
}

// Validates EAN-13 / EAN-8 / UPC-A check digits locally — no external
// barcode database lookup, just confirms the digits Claude read are
// internally consistent (a real, well-formed barcode). Uses the standard
// GS1 GTIN algorithm: pad to 14 digits, then weight 3/1 alternating from
// the rightmost data digit — this single rule is correct for all three
// lengths (no separate odd/even-length special-casing needed).
function isValidBarcodeChecksum(barcode: string): boolean {
  const digits = barcode.replace(/\D/g, "");
  if (digits.length !== 8 && digits.length !== 12 && digits.length !== 13) return false;

  const padded = digits.padStart(14, "0");
  const checkDigit = Number(padded[13]);
  let sum = 0;
  for (let i = 0; i < 13; i++) {
    const distanceFromRight = 12 - i;
    const weight = distanceFromRight % 2 === 0 ? 3 : 1;
    sum += Number(padded[i]) * weight;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === checkDigit;
}

// Local Supabase (Docker/kong) signs storage URLs with an internal hostname
// the browser can't reach — rewrite to 127.0.0.1 outside of production.
function rewriteLocalUrl(u: string): string {
  const internalUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const isLocal = internalUrl.includes("kong") || internalUrl.includes("supabase_");
  if (!isLocal) return u;
  return u.replace(/^https?:\/\/[^/]+(?=\/storage\/)/, "http://127.0.0.1:54321");
}

// Shapes a raw product_catalog row (with `supplier` and `usage` embeds) into
// the flat ProductRow the frontend expects — shared by the list and
// single-product GET handlers so both stay in sync.
function normalizeProduct(row: Record<string, unknown>) {
  const minAlert = row.min_stock_alert as number | null;
  const currentStock = row.current_stock as number;
  const isLowStock = minAlert !== null && currentStock <= minAlert;
  const supplierRow = row.supplier as { id: string; name: string } | null;
  const usageRow = row.usage as { count: number }[] | null;
  const { supplier: _s, usage: _u, ...rest } = row;
  return {
    ...rest,
    supplier_id: supplierRow?.id ?? null,
    supplier_name: supplierRow?.name ?? null,
    is_low_stock: isLowStock,
    service_count: usageRow?.[0]?.count ?? 0,
  };
}

Deno.serve(withLogging("products", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");
  const id = url.searchParams.get("id");

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (method === "GET") {
      // GET /products?action=service-usage&service_id=
      if (action === "service-usage") {
        const serviceId = url.searchParams.get("service_id");
        if (!serviceId) return badRequest("service_id is required");

        const { data: service } = await supabaseAdmin
          .from("services")
          .select("business_id")
          .eq("id", serviceId)
          .single();
        if (!service) return notFound("Service not found");

        try {
          const user = await verifyAuth(req);
          await verifyBusinessMember(user.id, (service as Record<string, unknown>).business_id as string);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }

        const { data, error } = await supabaseAdmin
          .from("service_product_usage")
          .select(`*, product:product_catalog(id, name, sku, unit, unit_cost, current_stock)`)
          .eq("service_id", serviceId);

        if (error) return serverError(error.message);
        return jsonCors(req, { items: data ?? [] });
      }

      // GET /products?action=recent-movements&business_id=
      // Recent stock movements across every product for the business —
      // powers the owner's unified "Recent activity" feed (Costs &
      // Inventory overview). needs_review is computed here, not stored:
      // a wastage/manual_out movement with no reference_id (not tied to a
      // supplier order or an appointment's service-use) has no paper
      // trail explaining it, so it's flagged for the owner to look at.
      if (action === "recent-movements") {
        const businessId = url.searchParams.get("business_id");
        if (!businessId) return badRequest("business_id is required");

        try {
          const user = await verifyAuth(req);
          await verifyBusinessMember(user.id, businessId);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }

        const limitParam = Number(url.searchParams.get("limit") ?? "20");
        const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;

        const { data, error } = await supabaseAdmin
          .from("stock_movements")
          .select(`
            id, movement_type, quantity, reference_id, reference_type, created_at,
            product:product_catalog(name, unit)
          `)
          .eq("business_id", businessId)
          .order("created_at", { ascending: false })
          .limit(limit);

        if (error) return serverError(error.message);

        const movements = (data ?? []).map((row: Record<string, unknown>) => {
          const product = row.product as { name: string; unit: string | null } | null;
          const needsReview =
            (row.movement_type === "wastage" || row.movement_type === "manual_out") &&
            row.reference_id == null;
          const { product: _p, ...rest } = row;
          return {
            ...rest,
            product_name: product?.name ?? "Product",
            unit: product?.unit ?? null,
            needs_review: needsReview,
          };
        });

        return jsonCors(req, { movements });
      }

      // GET /products?action=scan-photos&product_id=
      if (action === "scan-photos") {
        const productId = url.searchParams.get("product_id");
        if (!productId) return badRequest("product_id is required");

        const { data: productRow } = await supabaseAdmin.from("product_catalog").select("business_id").eq("id", productId).single();
        if (!productRow) return notFound("Product not found");

        try {
          const user = await verifyAuth(req);
          await verifyBusinessMember(user.id, (productRow as Record<string, unknown>).business_id as string);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }

        const { data, error } = await supabaseAdmin
          .from("product_scan_photos")
          .select("*")
          .eq("product_id", productId)
          .order("created_at", { ascending: true });

        if (error) return serverError(error.message);

        const photos = await Promise.all((data ?? []).map(async (row: Record<string, unknown>) => {
          const { data: signed } = await supabaseAdmin.storage.from("product-scans").createSignedUrl(row.storage_path as string, 3600);
          return { ...row, url: signed?.signedUrl ? rewriteLocalUrl(signed.signedUrl) : null };
        }));

        return jsonCors(req, { photos });
      }

      // GET /products?id=
      if (id) {
        const { data: product, error } = await supabaseAdmin
          .from("product_catalog")
          .select(`*, supplier:suppliers(id, name), usage:service_product_usage(count)`)
          .eq("id", id)
          .single();

        if (error || !product) return notFound("Product not found");

        try {
          const user = await verifyAuth(req);
          await verifyBusinessMember(user.id, (product as Record<string, unknown>).business_id as string);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }

        const { data: movements } = await supabaseAdmin
          .from("stock_movements")
          .select("*")
          .eq("product_id", id)
          .order("created_at", { ascending: false })
          .limit(20);

        return jsonCors(req, { ...normalizeProduct(product as Record<string, unknown>), movements: movements ?? [] });
      }

      // GET /products?business_id=
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      try {
        const user = await verifyAuth(req);
        await verifyBusinessMember(user.id, businessId);
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }

      const { data, error, count } = await supabaseAdmin
        .from("product_catalog")
        .select(`*, supplier:suppliers(id, name), usage:service_product_usage(count)`, { count: "exact" })
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("category", { ascending: true })
        .order("name", { ascending: true });

      if (error) return serverError(error.message);

      const products = (data ?? []).map((row) => normalizeProduct(row as Record<string, unknown>));

      return jsonCors(req, { products, total: count ?? 0 });
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;

      // POST /products?action=service-usage
      if (action === "service-usage") {
        const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
        if (ctx instanceof Response) return ctx;

        const { data, error } = await supabaseAdmin
          .from("service_product_usage")
          .insert({
            service_id: body.service_id,
            product_id: body.product_id,
            quantity_per_service: body.quantity_per_service ?? 1,
          })
          .select(`*, product:product_catalog(id, name, sku, unit)`)
          .single();

        if (error) return serverError(error.message);

        logServiceActivity({
          businessId: ctx.businessId,
          serviceId: body.service_id as string,
          actorUserId: ctx.userId,
          eventType: "product_usage_added",
          payload: { product_id: body.product_id },
        });

        return jsonCors(req, data, 201);
      }

      // POST /products?action=scan — AI-extract product details from photos.
      // Uploads and records the photos regardless of what Claude returns, so
      // nothing is lost if the owner cancels or the extraction is poor.
      if (action === "scan") {
        const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
        if (ctx instanceof Response) return ctx;

        const images = body.images as { base64: string; media_type: string; kind: string }[] | undefined;
        if (!images?.length) return badRequest("images is required (1-3 photos)");
        if (images.length > 3) return badRequest("At most 3 photos are supported");

        const validKinds = new Set(["front_label", "barcode", "ingredients", "other"]);
        for (const img of images) {
          if (!validKinds.has(img.kind)) return badRequest(`Invalid photo kind: ${img.kind}`);
        }

        // Upload + record every photo first, independent of the vision call outcome.
        const savedPhotos: { id: string; kind: string; url: string | null }[] = [];
        for (const img of images) {
          const ext = img.media_type.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
          const storagePath = `${ctx.businessId}/${crypto.randomUUID()}.${ext}`;
          const bytes = Uint8Array.from(atob(img.base64), (c) => c.charCodeAt(0));

          const { error: uploadErr } = await supabaseAdmin.storage
            .from("product-scans")
            .upload(storagePath, bytes, { contentType: img.media_type, upsert: false });
          if (uploadErr) {
            console.error("product-scans upload error:", uploadErr.message);
            continue;
          }

          const { data: photoRow, error: insertErr } = await supabaseAdmin
            .from("product_scan_photos")
            .insert({ business_id: ctx.businessId, kind: img.kind, storage_path: storagePath, created_by: ctx.userId })
            .select()
            .single();
          if (insertErr) {
            console.error("product_scan_photos insert error:", insertErr.message);
            continue;
          }

          const { data: signed } = await supabaseAdmin.storage.from("product-scans").createSignedUrl(storagePath, 3600);
          savedPhotos.push({
            id: (photoRow as Record<string, unknown>).id as string,
            kind: img.kind,
            url: signed?.signedUrl ? rewriteLocalUrl(signed.signedUrl) : null,
          });
        }

        let extracted: ScannedProductResult | null = null;
        let visionError: string | null = null;
        try {
          extracted = await callClaudeVisionForProduct(images.map((i) => ({ media_type: i.media_type, data: i.base64 })));
        } catch (e) {
          console.error("product vision scan error:", e);
          visionError = e instanceof Error ? e.message : "Failed to analyze photos";
        }

        const barcodeVerified = !!extracted?.barcode && isValidBarcodeChecksum(extracted.barcode);

        // Duplicate detection: exact barcode match first, else a fuzzy name match.
        let possibleDuplicate: Record<string, unknown> | null = null;
        if (extracted?.barcode || extracted?.name) {
          // deno-lint-ignore no-explicit-any
          let dupQuery: any = supabaseAdmin
            .from("product_catalog")
            .select("id, name, sku, size_label, colour, photo_url")
            .eq("business_id", ctx.businessId)
            .eq("is_active", true)
            .limit(1);

          dupQuery = extracted.barcode
            ? dupQuery.eq("barcode", extracted.barcode)
            : dupQuery.ilike("name", `%${extracted!.name}%`);

          const { data: dup } = await dupQuery.maybeSingle();
          possibleDuplicate = dup ?? null;
        }

        return jsonCors(req, {
          photos: savedPhotos,
          extracted,
          vision_error: visionError,
          barcode_verified: barcodeVerified,
          possible_duplicate: possibleDuplicate,
        });
      }

      // POST /products — create product
      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
      if (ctx instanceof Response) return ctx;

      const { data, error } = await supabaseAdmin
        .from("product_catalog")
        .insert({
          business_id: ctx.businessId,
          supplier_id: body.supplier_id ?? null,
          name: body.name,
          sku: body.sku ?? null,
          category: body.category ?? null,
          unit: body.unit ?? "piece",
          unit_cost: body.unit_cost ?? null,
          current_stock: body.current_stock ?? 0,
          min_stock_alert: body.min_stock_alert ?? null,
          photo_url: body.photo_url ?? null,
          brand: body.brand ?? null,
          barcode: body.barcode ?? null,
          colour: body.colour ?? null,
          size_label: body.size_label ?? null,
          description: body.description ?? null,
          storage_location: body.storage_location ?? null,
          brand_logo_url: body.brand_logo_url ?? null,
          is_draft: body.is_draft ?? false,
        })
        .select()
        .single();

      if (error) return serverError(error.message);
      const newProduct = data as Record<string, unknown>;

      // Link any scan photos taken during the "Scan product" flow to the
      // now-created product.
      const scanPhotoIds = body.scan_photo_ids as string[] | undefined;
      if (scanPhotoIds?.length) {
        await supabaseAdmin
          .from("product_scan_photos")
          .update({ product_id: newProduct.id })
          .in("id", scanPhotoIds)
          .eq("business_id", ctx.businessId);
      }

      // Optionally record a first purchase alongside creation — a separate
      // audit row, not a second stock adjustment (current_stock above is
      // already the authoritative starting count the owner entered).
      const purchase = body.purchase as {
        quantity?: number; unit_cost?: number; vat_rate?: number; purchase_date?: string; receipt_base64?: string; receipt_media_type?: string;
      } | undefined;
      if (purchase?.quantity) {
        const { error: moveErr } = await supabaseAdmin.from("stock_movements").insert({
          business_id: ctx.businessId,
          product_id: newProduct.id,
          movement_type: "purchase",
          quantity: Math.abs(purchase.quantity),
          unit_cost: purchase.unit_cost ?? null,
          vat_rate: purchase.vat_rate ?? null,
          movement_date: purchase.purchase_date ?? new Date().toISOString().slice(0, 10),
          receipt_url: purchase.receipt_base64 ? `data:${purchase.receipt_media_type ?? "image/jpeg"};base64,${purchase.receipt_base64}` : null,
          reference_type: "manual",
          created_by: ctx.userId,
        });
        if (moveErr) console.error("first-purchase stock_movements insert error:", moveErr.message);
      }

      return jsonCors(req, newProduct, 201);
    }

    // ── PATCH ──────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (!id) return badRequest("id is required");

      // PATCH /products?action=adjust&id=  — manual stock adjustment
      if (action === "adjust") {
        const body = await req.json() as Record<string, unknown>;

        const { data: product } = await supabaseAdmin
          .from("product_catalog")
          .select("business_id, current_stock")
          .eq("id", id)
          .single();
        if (!product) return notFound("Product not found");

        const ctx = await requireOwnerOrManagerCtx(req, (product as Record<string, unknown>).business_id as string);
        if (ctx instanceof Response) return ctx;

        const movementType = body.movement_type as string;
        const rawQty = Number(body.quantity);
        const signedQty = (movementType === "manual_in" || movementType === "purchase")
          ? Math.abs(rawQty)
          : -Math.abs(rawQty);

        const { data: movRow, error: movErr } = await supabaseAdmin
          .from("stock_movements")
          .insert({
            business_id: ctx.businessId,
            product_id: id,
            movement_type: movementType,
            quantity: signedQty,
            unit_cost: body.unit_cost ?? null,
            vat_rate: movementType === "purchase" ? (body.vat_rate ?? null) : null,
            movement_date: body.movement_date ?? new Date().toISOString().slice(0, 10),
            receipt_url: body.receipt_base64
              ? `data:${body.receipt_media_type ?? "image/jpeg"};base64,${body.receipt_base64}`
              : null,
            reference_type: "manual",
            notes: body.notes ?? null,
            created_by: ctx.userId,
          })
          .select("id")
          .single();

        if (movErr) return serverError(movErr.message);

        const newStock = (product as Record<string, unknown>).current_stock as number + signedQty;
        const { data: updated, error: updErr } = await supabaseAdmin
          .from("product_catalog")
          .update({ current_stock: newStock, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();

        if (updErr) return serverError(updErr.message);
        return jsonCors(req, { ...updated, movement_id: (movRow as Record<string, unknown>).id });
      }

      // PATCH /products?action=service-usage&id=  — update linked quantity
      if (action === "service-usage") {
        const body = await req.json() as Record<string, unknown>;
        const quantity = Number(body.quantity_per_service);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          return badRequest("quantity_per_service must be a positive number");
        }

        const { data: usage } = await supabaseAdmin
          .from("service_product_usage")
          .select(`service_id, product_id, service:services(business_id)`)
          .eq("id", id)
          .maybeSingle();
        if (!usage) return notFound("Usage entry not found");

        const bizId = ((usage as Record<string, unknown>).service as Record<string, unknown>)?.business_id as string;
        const ctx = await requireOwnerOrManagerCtx(req, bizId);
        if (ctx instanceof Response) return ctx;

        const { data, error } = await supabaseAdmin
          .from("service_product_usage")
          .update({ quantity_per_service: quantity })
          .eq("id", id)
          .select(`*, product:product_catalog(id, name, sku, unit)`)
          .single();

        if (error) return serverError(error.message);

        logServiceActivity({
          businessId: ctx.businessId,
          serviceId: (usage as Record<string, unknown>).service_id as string,
          actorUserId: ctx.userId,
          eventType: "product_usage_updated",
          payload: { product_id: (usage as Record<string, unknown>).product_id, quantity_per_service: quantity },
        });

        return jsonCors(req, data);
      }

      // PATCH /products?action=deactivate&id=
      if (action === "deactivate") {
        const { data: product } = await supabaseAdmin
          .from("product_catalog")
          .select("business_id")
          .eq("id", id)
          .single();
        if (!product) return notFound("Product not found");

        const ctx = await requireOwnerOrManagerCtx(req, (product as Record<string, unknown>).business_id as string);
        if (ctx instanceof Response) return ctx;

        const { error } = await supabaseAdmin
          .from("product_catalog")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", id);

        if (error) return serverError(error.message);
        return jsonCors(req, { ok: true });
      }

      // PATCH /products?id= — general update
      const body = await req.json() as Record<string, unknown>;
      const { data: product } = await supabaseAdmin
        .from("product_catalog")
        .select("business_id")
        .eq("id", id)
        .single();
      if (!product) return notFound("Product not found");

      const ctx = await requireOwnerOrManagerCtx(req, (product as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const allowedFields = [
        "name", "sku", "category", "unit", "unit_cost", "min_stock_alert", "supplier_id", "photo_url",
        "brand", "barcode", "colour", "size_label", "description", "storage_location", "brand_logo_url", "is_draft",
      ];
      const updatePayload: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const field of allowedFields) {
        if (field in body) updatePayload[field] = body[field];
      }

      const { data, error } = await supabaseAdmin
        .from("product_catalog")
        .update(updatePayload)
        .eq("id", id)
        .select()
        .single();

      if (error) return serverError(error.message);
      return jsonCors(req, data);
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    if (method === "DELETE") {
      // DELETE /products?action=service-usage&id=
      if (action === "service-usage") {
        if (!id) return badRequest("id is required");

        const { data: usage } = await supabaseAdmin
          .from("service_product_usage")
          .select(`service_id, product_id, service:services(business_id)`)
          .eq("id", id)
          .single();
        if (!usage) return notFound("Usage entry not found");

        const bizId = ((usage as Record<string, unknown>).service as Record<string, unknown>)?.business_id as string;
        const ctx = await requireOwnerOrManagerCtx(req, bizId);
        if (ctx instanceof Response) return ctx;

        const { error } = await supabaseAdmin
          .from("service_product_usage")
          .delete()
          .eq("id", id);

        if (error) return serverError(error.message);

        logServiceActivity({
          businessId: ctx.businessId,
          serviceId: (usage as Record<string, unknown>).service_id as string,
          actorUserId: ctx.userId,
          eventType: "product_usage_removed",
          payload: { product_id: (usage as Record<string, unknown>).product_id },
        });

        return jsonCors(req, { ok: true });
      }

      return badRequest("Method not allowed");
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("products error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
