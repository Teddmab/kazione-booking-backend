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
 * POST                body={business_id,...}  → create product
 * POST ?action=service-usage                  → link product to service
 * PATCH ?id=          body={...fields}        → update product fields
 * PATCH ?action=adjust&id=                    → manual stock adjustment
 * PATCH ?action=deactivate&id=               → soft-delete product
 * PATCH ?action=service-usage&id=            → update a service-product link's quantity
 * DELETE ?action=service-usage&id=           → remove service-product link
 */
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

      // GET /products?id=
      if (id) {
        const { data: product, error } = await supabaseAdmin
          .from("product_catalog")
          .select(`*, supplier:suppliers(id, name)`)
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

        return jsonCors(req, { ...product, movements: movements ?? [] });
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
        .select(`*, supplier:suppliers(id, name)`, { count: "exact" })
        .eq("business_id", businessId)
        .eq("is_active", true)
        .order("category", { ascending: true })
        .order("name", { ascending: true });

      if (error) return serverError(error.message);

      const products = (data ?? []).map((row: Record<string, unknown>) => {
        const minAlert = row.min_stock_alert as number | null;
        const currentStock = row.current_stock as number;
        const isLowStock = minAlert !== null && currentStock <= minAlert;
        const supplierRow = row.supplier as { id: string; name: string } | null;
        const { supplier: _s, ...rest } = row;
        return {
          ...rest,
          supplier_id: supplierRow?.id ?? null,
          supplier_name: supplierRow?.name ?? null,
          is_low_stock: isLowStock,
        };
      });

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
        })
        .select()
        .single();

      if (error) return serverError(error.message);
      return jsonCors(req, data, 201);
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

        const { error: movErr } = await supabaseAdmin
          .from("stock_movements")
          .insert({
            business_id: ctx.businessId,
            product_id: id,
            movement_type: movementType,
            quantity: signedQty,
            unit_cost: body.unit_cost ?? null,
            reference_type: "manual",
            notes: body.notes ?? null,
            created_by: ctx.userId,
          });

        if (movErr) return serverError(movErr.message);

        const newStock = (product as Record<string, unknown>).current_stock as number + signedQty;
        const { data: updated, error: updErr } = await supabaseAdmin
          .from("product_catalog")
          .update({ current_stock: newStock, updated_at: new Date().toISOString() })
          .eq("id", id)
          .select()
          .single();

        if (updErr) return serverError(updErr.message);
        return jsonCors(req, updated);
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

      const allowedFields = ["name", "sku", "category", "unit", "unit_cost", "min_stock_alert", "supplier_id", "photo_url"];
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
