import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * /suppliers — suppliers CRUD + supplier order management
 *
 * GET  ?business_id=&[search=&isActive=&page=&limit=]      → supplier list with stats
 * GET  ?id=                                                 → single supplier detail
 * GET  ?action=orders&business_id=&[supplier_id=&status=&page=&limit=]
 *                                                           → paginated supplier orders
 * POST                body={business_id, ...fields}        → create supplier
 * POST ?action=order  body={business_id, ...order}         → create supplier order
 * PATCH ?id=          body={...fields}                     → update supplier
 * PATCH ?action=deactivate&id=                             → soft-delete supplier
 * PATCH ?action=order-status&id=   body={status}           → update order status
 */
Deno.serve(withLogging("suppliers", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");
  const id = url.searchParams.get("id");

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (method === "GET") {
      if (action === "orders") {
        const businessId = url.searchParams.get("business_id");
        if (!businessId) return badRequest("business_id is required");

        try {
          const user = await verifyAuth(req);
          await verifyBusinessMember(user.id, businessId);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }

        const page = parseInt(url.searchParams.get("page") ?? "1", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "25", 10);
        const supplierId = url.searchParams.get("supplier_id");
        const statusParams = url.searchParams.getAll("status");

        // deno-lint-ignore no-explicit-any
        let query: any = supabaseAdmin
          .from("supplier_orders")
          .select(`*, items:supplier_order_items(*), supplier:suppliers(name)`, { count: "exact" })
          .eq("business_id", businessId)
          .order("created_at", { ascending: false });

        if (supplierId) query = query.eq("supplier_id", supplierId);
        if (statusParams?.length) query = query.in("status", statusParams);

        const from = (page - 1) * limit;
        query = query.range(from, from + limit - 1);

        const { data, error, count } = await query;
        if (error) return serverError(error.message);
        return json({ orders: data ?? [], total: count ?? 0 });
      }

      if (id) {
        const { data, error } = await supabaseAdmin
          .from("suppliers")
          .select("*")
          .eq("id", id)
          .single();

        if (error) return notFound("Supplier not found");

        try {
          const user = await verifyAuth(req);
          await verifyBusinessMember(user.id, (data as Record<string, unknown>).business_id as string);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }

        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        const [expRows, orderRows, spendRows] = await Promise.all([
          supabaseAdmin.from("expenses").select("id, description, amount, date, category").eq("supplier_id", id).order("date", { ascending: false }).limit(10),
          supabaseAdmin.from("supplier_orders").select("id, reference, status, total_amount, ordered_at, expected_at").eq("supplier_id", id).in("status", ["draft", "ordered"]).order("created_at", { ascending: false }),
          supabaseAdmin.from("expenses").select("amount, date").eq("supplier_id", id).gte("date", sixMonthsAgo.toISOString().slice(0, 10)),
        ]);

        const monthlyMap = new Map<string, number>();
        for (const row of spendRows.data ?? []) {
          const month = (row as Record<string, unknown>).date as string;
          const monthKey = month.slice(0, 7);
          monthlyMap.set(monthKey, (monthlyMap.get(monthKey) ?? 0) + ((row as Record<string, unknown>).amount as number));
        }
        const monthly_spend = Array.from(monthlyMap.entries())
          .map(([month, amount]) => ({ month, amount }))
          .sort((a, b) => a.month.localeCompare(b.month));

        return json({ ...data, recent_expenses: expRows.data ?? [], open_orders: orderRows.data ?? [], monthly_spend });
      }

      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      try {
        const user = await verifyAuth(req);
        await verifyBusinessMember(user.id, businessId);
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }

      const page = parseInt(url.searchParams.get("page") ?? "1", 10);
      const limit = parseInt(url.searchParams.get("limit") ?? "25", 10);
      const search = url.searchParams.get("search");
      const isActiveParam = url.searchParams.get("is_active");

      // deno-lint-ignore no-explicit-any
      let query: any = supabaseAdmin
        .from("suppliers")
        .select(`*, expenses:expenses(amount), orders:supplier_orders(id, status)`, { count: "exact" })
        .eq("business_id", businessId)
        .order("name", { ascending: true });

      if (search) query = query.or(`name.ilike.%${search}%,contact_name.ilike.%${search}%,email.ilike.%${search}%`);
      if (isActiveParam !== null) query = query.eq("is_active", isActiveParam === "true");

      const from = (page - 1) * limit;
      query = query.range(from, from + limit - 1);

      const { data, error, count } = await query;
      if (error) return serverError(error.message);

      const suppliers = (data ?? []).map((row: Record<string, unknown>) => {
        const expenses = (row.expenses as { amount: number }[]) ?? [];
        const orders = (row.orders as { id: string; status: string }[]) ?? [];
        const total_spent = expenses.reduce((sum, e) => sum + e.amount, 0);
        const open_orders = orders.filter((o) => o.status === "draft" || o.status === "ordered").length;
        const { expenses: _e, orders: _o, ...supplier } = row;
        return { ...supplier, total_spent, open_orders };
      });

      return json({ suppliers, total: count ?? 0 });
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;

      if (action === "order") {
        const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
        if (ctx instanceof Response) return ctx;

        const items = body.items as { product_name: string; sku?: string; quantity: number; unit_price: number }[];
        const total_amount = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);

        const { data: order, error: orderErr } = await supabaseAdmin
          .from("supplier_orders")
          .insert({
            business_id: ctx.businessId,
            supplier_id: body.supplier_id,
            reference: body.reference ?? null,
            notes: body.notes ?? null,
            ordered_at: body.ordered_at ?? null,
            expected_at: body.expected_at ?? null,
            total_amount,
            created_by: ctx.userId,
          })
          .select()
          .single();

        if (orderErr) return serverError(orderErr.message);

        const itemRows = items.map((item) => ({
          order_id: (order as Record<string, unknown>).id,
          product_name: item.product_name,
          sku: item.sku ?? null,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_price: item.quantity * item.unit_price,
        }));

        const { error: itemsErr } = await supabaseAdmin.from("supplier_order_items").insert(itemRows);
        if (itemsErr) return serverError(itemsErr.message);

        const { data: full, error: fetchErr } = await supabaseAdmin
          .from("supplier_orders")
          .select(`*, items:supplier_order_items(*), supplier:suppliers(name)`)
          .eq("id", (order as Record<string, unknown>).id as string)
          .single();

        if (fetchErr) return serverError(fetchErr.message);
        return json(full, 201);
      }

      // Create supplier
      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
      if (ctx instanceof Response) return ctx;

      const { business_id: _, ...input } = body;
      const { data, error } = await supabaseAdmin
        .from("suppliers")
        .insert({ ...input, business_id: ctx.businessId })
        .select()
        .single();

      if (error) return serverError(error.message);
      return json(data, 201);
    }

    // ── PATCH ──────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (!id) return badRequest("id is required");

      if (action === "order-status") {
        const body = await req.json() as Record<string, unknown>;
        const status = body.status as string;

        const { data: existing } = await supabaseAdmin.from("supplier_orders").select("business_id").eq("id", id).single();
        if (!existing) return notFound("Order not found");

        const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
        if (ctx instanceof Response) return ctx;

        const update: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
        if (status === "received") update.received_at = new Date().toISOString();

        const { data, error } = await supabaseAdmin
          .from("supplier_orders")
          .update(update)
          .eq("id", id)
          .select(`*, items:supplier_order_items(*), supplier:suppliers(name)`)
          .single();

        if (error) return serverError(error.message);

        // Auto stock-in: when order received, resolve/create products then update stock
        if (status === "received" && data) {
          const order = data as Record<string, unknown>;
          const businessId = order.business_id as string;
          const supplierId = order.supplier_id as string | null;
          const items = (order.items as Record<string, unknown>[]) ?? [];

          for (const item of items) {
            const qty = Number(item.quantity);
            const unitCost = item.unit_price != null ? Number(item.unit_price) : null;
            const productName = (item.product_name as string).trim();
            const sku = (item.sku as string | null) ?? null;

            // Resolve product: prefer product_id already set, else match by SKU or name
            let productId = item.product_id as string | null ?? null;

            if (!productId) {
              // Try to find an existing product for this business by SKU first, then name
              let matchQuery = supabaseAdmin
                .from("product_catalog")
                .select("id, current_stock")
                .eq("business_id", businessId)
                .eq("is_active", true);

              if (sku) {
                matchQuery = matchQuery.eq("sku", sku);
              } else {
                matchQuery = matchQuery.ilike("name", productName);
              }

              const { data: match } = await matchQuery.maybeSingle();

              if (match) {
                productId = (match as Record<string, unknown>).id as string;
              } else {
                // Auto-create product from order item
                const { data: created, error: createErr } = await supabaseAdmin
                  .from("product_catalog")
                  .insert({
                    business_id: businessId,
                    supplier_id: supplierId,
                    name: productName,
                    sku: sku,
                    unit: "unit",
                    unit_cost: unitCost,
                    current_stock: 0,
                    is_active: true,
                  })
                  .select("id")
                  .single();

                if (createErr) {
                  console.error("product auto-create error:", createErr.message);
                  continue;
                }
                productId = (created as Record<string, unknown>).id as string;
              }

              // Back-fill product_id on the order item for future reference
              await supabaseAdmin
                .from("supplier_order_items")
                .update({ product_id: productId })
                .eq("id", item.id as string);
            }

            // Create stock movement
            const { error: mvErr } = await supabaseAdmin.from("stock_movements").insert({
              business_id: businessId,
              product_id: productId,
              movement_type: "purchase",
              quantity: qty,
              unit_cost: unitCost,
              reference_id: id,
              reference_type: "supplier_order",
              created_by: ctx.userId,
            });
            if (mvErr) console.error("stock_movements insert error:", mvErr.message);

            // Increment current_stock
            const { data: prod } = await supabaseAdmin
              .from("product_catalog")
              .select("current_stock")
              .eq("id", productId)
              .single();
            if (prod) {
              await supabaseAdmin
                .from("product_catalog")
                .update({
                  current_stock: (prod as Record<string, unknown>).current_stock as number + qty,
                  unit_cost: unitCost ?? (prod as Record<string, unknown>).unit_cost,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", productId);
            }
          }
        }

        return json(data);
      }

      if (action === "deactivate") {
        const { data: existing } = await supabaseAdmin.from("suppliers").select("business_id").eq("id", id).single();
        if (!existing) return notFound("Supplier not found");

        const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
        if (ctx instanceof Response) return ctx;

        const { error } = await supabaseAdmin.from("suppliers")
          .update({ is_active: false, updated_at: new Date().toISOString() })
          .eq("id", id);

        if (error) return serverError(error.message);
        return json({ ok: true });
      }

      // General update
      const body = await req.json() as Record<string, unknown>;
      const { data: existing } = await supabaseAdmin.from("suppliers").select("business_id").eq("id", id).single();
      if (!existing) return notFound("Supplier not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const { data, error } = await supabaseAdmin
        .from("suppliers")
        .update({ ...body, updated_at: new Date().toISOString() })
        .eq("id", id)
        .select()
        .single();

      if (error) return serverError(error.message);
      return json(data);
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("suppliers error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
