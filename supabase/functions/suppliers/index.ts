import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";

// Local Supabase (Docker/kong) signs storage URLs with an internal hostname
// the browser can't reach — rewrite to 127.0.0.1 outside of production.
function rewriteLocalUrl(u: string): string {
  const internalUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const isLocal = internalUrl.includes("kong") || internalUrl.includes("supabase_");
  if (!isLocal) return u;
  return u.replace(/^https?:\/\/[^/]+(?=\/storage\/)/, "http://127.0.0.1:54321");
}

// ── Needs-attention detection + spend/outstanding computation ──────────────
// Shared by both the list GET handler and ?action=summary so the two can't
// drift into inconsistent counts.

const LEGAL_SUFFIXES = new Set([
  "OU", "OÜ", "LTD", "LLC", "INC", "GMBH", "AS", "OY", "AB", "SA", "SARL", "CORP", "CO",
]);

function normalizeSupplierName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[.,'"()]/g, "");
  const words = cleaned.split(/\s+/).filter(Boolean);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1].toUpperCase())) {
    words.pop();
  }
  return words.join(" ");
}

// A row whose name matches this AND is still classified as a real supplier
// is flagged "possible_non_supplier" — most often a tax authority or other
// government biller added via "Add Supplier" as a catch-all.
const NON_SUPPLIER_KEYWORDS = /\b(tax|vat office|customs|excise|inland revenue|emta|irs|hmrc)\b/i;

type SupplierTypeValue = "product" | "rent" | "utility" | "service" | "other";
type DisplayBucket = "product" | "service" | "rent_utility" | "other";

function toDisplayBucket(t: SupplierTypeValue): DisplayBucket {
  if (t === "rent" || t === "utility") return "rent_utility";
  if (t === "product" || t === "service") return t;
  return "other";
}

function maxIsoDate(dates: (string | null | undefined)[]): string | null {
  const valid = dates.filter((d): d is string => !!d);
  if (!valid.length) return null;
  return valid.reduce((max, d) => (new Date(d).getTime() > new Date(max).getTime() ? d : max));
}

interface RawSupplierOrder {
  status: string;
  total_amount: number;
  paid_at: string | null;
  received_at: string | null;
  created_at: string;
}

interface RawSupplierDebt {
  status: string;
  current_balance: number;
}

interface RawSupplierRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  registration_id: string | null;
  entity_type: string;
  updated_at: string;
  is_active: boolean;
  orders?: RawSupplierOrder[];
  debts?: RawSupplierDebt[];
}

function computeSupplierFields(
  row: RawSupplierRow,
  from: string | null,
  to: string | null,
  dupIds: Set<string>,
) {
  const orders = row.orders ?? [];
  const debts = row.debts ?? [];

  const total_spent = orders.filter((o) => o.status === "received").reduce((s, o) => s + o.total_amount, 0);
  const open_orders = orders.filter((o) => o.status === "draft" || o.status === "ordered").length;

  const receivedUnpaid = orders
    .filter((o) => o.status === "received" && o.paid_at == null)
    .reduce((s, o) => s + o.total_amount, 0);
  const activeDebtBalance = debts
    .filter((d) => d.status === "active")
    .reduce((s, d) => s + Number(d.current_balance), 0);
  const outstanding = receivedUnpaid + activeDebtBalance;

  let spend_period: number | null = null;
  if (from && to) {
    spend_period = orders
      .filter((o) => o.status === "received")
      .filter((o) => {
        const d = (o.received_at ?? o.created_at).slice(0, 10);
        return d >= from && d <= to;
      })
      .reduce((s, o) => s + o.total_amount, 0);
  }

  const missing_contact = !row.email && !row.phone;
  const possible_duplicate = row.is_active && dupIds.has(row.id);
  const possible_non_supplier = row.entity_type === "supplier" && NON_SUPPLIER_KEYWORDS.test(row.name);
  const last_activity_at = maxIsoDate([row.updated_at, ...orders.map((o) => o.created_at)]);

  return {
    total_spent, open_orders, spend_period, outstanding,
    missing_contact, possible_duplicate, possible_non_supplier, last_activity_at,
  };
}

// Duplicate detection ALWAYS runs against every active supplier of the
// business, never just the current filtered/paginated page — otherwise a
// duplicate on another page (or hidden by the current type pill) would
// silently stop being flagged.
function findDuplicateIds(active: { id: string; name: string; registration_id: string | null }[]): Set<string> {
  const byName = new Map<string, string[]>();
  const byReg = new Map<string, string[]>();
  for (const s of active) {
    const n = normalizeSupplierName(s.name);
    byName.set(n, [...(byName.get(n) ?? []), s.id]);
    if (s.registration_id) byReg.set(s.registration_id, [...(byReg.get(s.registration_id) ?? []), s.id]);
  }
  const dup = new Set<string>();
  for (const ids of byName.values()) if (ids.length > 1) ids.forEach((id) => dup.add(id));
  for (const ids of byReg.values()) if (ids.length > 1) ids.forEach((id) => dup.add(id));
  return dup;
}

/**
 * /suppliers — suppliers CRUD + supplier order management
 *
 * GET  ?business_id=&[search=&is_active=&supplier_type=(repeatable)&needs_attention=true&from=&to=&sort=name|spend_desc|outstanding_desc|last_activity_desc&page=&limit=]
 *                                                           → supplier list with stats + needs-attention flags
 * GET  ?id=                                                 → single supplier detail
 * GET  ?action=summary&business_id=&from=&to=                → business-wide totals, needs-attention counts, spend by type
 * GET  ?action=orders&business_id=&[supplier_id=&status=&page=&limit=]
 *                                                           → paginated supplier orders
 * GET  ?action=documents&supplier_id=                       → supplier's documents & notes
 * POST                body={business_id, ...fields}        → create supplier
 * POST ?action=order  body={business_id, ...order}         → create supplier order
 * POST ?action=document body={business_id, supplier_id, kind, ...}
 *                                                           → add a document or note
 * PATCH ?id=          body={...fields}                     → update supplier
 * PATCH ?action=deactivate&id=                             → soft-delete supplier
 * PATCH ?action=order-status&id=   body={status, due_date?} → update order status
 * PATCH ?action=order-payment&id=  body={paid_at?, due_date?}
 *                                                           → record/clear order payment
 * DELETE ?action=document&id=                               → delete a document or note
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
        return jsonCors(req, { orders: data ?? [], total: count ?? 0 });
      }

      if (action === "documents") {
        const supplierId = url.searchParams.get("supplier_id");
        if (!supplierId) return badRequest("supplier_id is required");

        const { data: supplierRow } = await supabaseAdmin.from("suppliers").select("business_id").eq("id", supplierId).single();
        if (!supplierRow) return notFound("Supplier not found");

        try {
          const user = await verifyAuth(req);
          await verifyBusinessMember(user.id, (supplierRow as Record<string, unknown>).business_id as string);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }

        const { data, error } = await supabaseAdmin
          .from("supplier_documents")
          .select("*")
          .eq("supplier_id", supplierId)
          .order("created_at", { ascending: false });

        if (error) return serverError(error.message);

        const documents = await Promise.all((data ?? []).map(async (row: Record<string, unknown>) => {
          if (!row.file_path) return { ...row, file_url: null };
          const { data: signed } = await supabaseAdmin.storage
            .from("supplier-documents")
            .createSignedUrl(row.file_path as string, 3600);
          return { ...row, file_url: signed?.signedUrl ? rewriteLocalUrl(signed.signedUrl) : null };
        }));

        return jsonCors(req, { documents });
      }

      if (action === "summary") {
        const businessId = url.searchParams.get("business_id");
        if (!businessId) return badRequest("business_id is required");
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");

        try {
          const user = await verifyAuth(req);
          await verifyBusinessMember(user.id, businessId);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }

        const { data, error } = await supabaseAdmin
          .from("suppliers")
          .select(`*, orders:supplier_orders(id, status, total_amount, paid_at, received_at, created_at), debts:business_debts(current_balance, status)`)
          .eq("business_id", businessId);
        if (error) return serverError(error.message);

        const rows = (data ?? []) as unknown as (RawSupplierRow & { supplier_type: SupplierTypeValue })[];
        const activeForDup = rows
          .filter((r) => r.is_active)
          .map((r) => ({ id: r.id, name: r.name, registration_id: r.registration_id }));
        const dupIds = findDuplicateIds(activeForDup);

        let total_spend_period = 0;
        let outstanding_total = 0;
        let open_orders_total = 0;
        let missing_contact_count = 0;
        let possible_duplicate_count = 0;
        let possible_non_supplier_count = 0;
        const spendByBucket = new Map<DisplayBucket, number>();

        for (const row of rows) {
          const c = computeSupplierFields(row, from, to, dupIds);
          total_spend_period += c.spend_period ?? 0;
          outstanding_total += c.outstanding;
          open_orders_total += c.open_orders;
          if (c.missing_contact) missing_contact_count++;
          if (c.possible_duplicate) possible_duplicate_count++;
          if (c.possible_non_supplier) possible_non_supplier_count++;

          const bucket = toDisplayBucket(row.supplier_type);
          spendByBucket.set(bucket, (spendByBucket.get(bucket) ?? 0) + (c.spend_period ?? 0));
        }

        const BUCKET_LABELS: Record<DisplayBucket, string> = {
          product: "Products", service: "Services", rent_utility: "Rent & utilities", other: "Other",
        };
        const spend_by_type = (["product", "service", "rent_utility", "other"] as DisplayBucket[])
          .map((b) => ({ type: b, label: BUCKET_LABELS[b], amount: spendByBucket.get(b) ?? 0 }))
          .filter((b) => b.amount > 0)
          .sort((a, b) => b.amount - a.amount);

        return jsonCors(req, {
          totals: {
            total_suppliers: rows.length,
            active_suppliers: rows.filter((r) => r.is_active).length,
            total_spend_period,
            outstanding_total,
            open_orders_total,
          },
          needs_attention: { missing_contact_count, possible_duplicate_count, possible_non_supplier_count },
          spend_by_type,
        });
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

        return jsonCors(req, data);
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
      const supplierTypeParams = url.searchParams.getAll("supplier_type");
      const needsAttentionOnly = url.searchParams.get("needs_attention") === "true";
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const sort = url.searchParams.get("sort") ?? "name";

      // Fetched in full (no DB-level pagination) rather than the previous
      // .range() approach: duplicate detection needs the whole active
      // population regardless of filters, and sorting by computed fields
      // (outstanding/spend/last-activity) isn't expressible as a plain
      // ORDER BY. Acceptable since a single business's supplier list is
      // realistically tens of rows, not thousands — same assumption already
      // made by FixedCostsTab/SpendingDashboard on the frontend.
      // deno-lint-ignore no-explicit-any
      let query: any = supabaseAdmin
        .from("suppliers")
        .select(`*, orders:supplier_orders(id, status, total_amount, paid_at, received_at, created_at), debts:business_debts(current_balance, status)`)
        .eq("business_id", businessId);

      if (search) query = query.or(`name.ilike.%${search}%,contact_name.ilike.%${search}%,email.ilike.%${search}%`);
      if (isActiveParam !== null) query = query.eq("is_active", isActiveParam === "true");
      if (supplierTypeParams?.length) query = query.in("supplier_type", supplierTypeParams);

      const { data, error } = await query;
      if (error) return serverError(error.message);

      // Duplicate detection needs the FULL active population of the
      // business, independent of the search/type/is_active filters above.
      const { data: activeAll, error: activeErr } = await supabaseAdmin
        .from("suppliers")
        .select("id, name, registration_id")
        .eq("business_id", businessId)
        .eq("is_active", true);
      if (activeErr) return serverError(activeErr.message);
      const dupIds = findDuplicateIds((activeAll ?? []) as { id: string; name: string; registration_id: string | null }[]);

      type SupplierListRow = Record<string, unknown> & ReturnType<typeof computeSupplierFields>;

      let suppliers: SupplierListRow[] = (data ?? []).map((row: Record<string, unknown>) => {
        const computed = computeSupplierFields(row as unknown as RawSupplierRow, from, to, dupIds);
        const { orders: _o, debts: _d, ...supplier } = row;
        return { ...supplier, ...computed };
      });

      if (needsAttentionOnly) {
        suppliers = suppliers.filter((s) => s.missing_contact || s.possible_duplicate || s.possible_non_supplier);
      }

      const sorters: Record<string, (a: SupplierListRow, b: SupplierListRow) => number> = {
        name: (a, b) => (a.name as string).localeCompare(b.name as string),
        spend_desc: (a, b) => ((b.spend_period ?? b.total_spent) as number) - ((a.spend_period ?? a.total_spent) as number),
        outstanding_desc: (a, b) => (b.outstanding as number) - (a.outstanding as number),
        last_activity_desc: (a, b) => ((b.last_activity_at as string) ?? "").localeCompare((a.last_activity_at as string) ?? ""),
      };
      suppliers.sort(sorters[sort] ?? sorters.name);

      const total = suppliers.length;
      const rangeStart = (page - 1) * limit;
      const pageRows = suppliers.slice(rangeStart, rangeStart + limit);

      return jsonCors(req, { suppliers: pageRows, total });
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
            due_date: body.due_date ?? null,
            total_amount,
            invoice_photo_url: body.invoice_photo_url ?? null,
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
        return jsonCors(req, full, 201);
      }

      if (action === "document") {
        const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
        if (ctx instanceof Response) return ctx;

        const supplierId = body.supplier_id as string;
        const kind = body.kind as string;
        if (!supplierId) return badRequest("supplier_id is required");
        if (kind !== "document" && kind !== "note") return badRequest("kind must be 'document' or 'note'");

        let filePath: string | null = null;
        let fileSize: number | null = null;
        let mimeType: string | null = null;

        if (kind === "document") {
          const fileBase64 = body.file_base64 as string | undefined;
          mimeType = (body.mime_type as string | undefined) ?? "application/octet-stream";
          if (!fileBase64) return badRequest("file_base64 is required for a document");

          const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "bin";
          filePath = `${ctx.businessId}/${supplierId}/${crypto.randomUUID()}.${ext}`;
          const fileBytes = Uint8Array.from(atob(fileBase64), (c) => c.charCodeAt(0));
          fileSize = fileBytes.byteLength;

          const { error: uploadErr } = await supabaseAdmin.storage
            .from("supplier-documents")
            .upload(filePath, fileBytes, { contentType: mimeType, upsert: false });
          if (uploadErr) return serverError(`Failed to upload document: ${uploadErr.message}`);
        }

        const { data, error } = await supabaseAdmin
          .from("supplier_documents")
          .insert({
            business_id: ctx.businessId,
            supplier_id: supplierId,
            kind,
            body: body.body ?? null,
            file_path: filePath,
            file_size: fileSize,
            mime_type: mimeType,
            created_by: ctx.userId,
          })
          .select()
          .single();

        if (error) return serverError(error.message);

        let fileUrl: string | null = null;
        if (filePath) {
          const { data: signed } = await supabaseAdmin.storage.from("supplier-documents").createSignedUrl(filePath, 3600);
          fileUrl = signed?.signedUrl ? rewriteLocalUrl(signed.signedUrl) : null;
        }

        return jsonCors(req, { ...data, file_url: fileUrl }, 201);
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
      return jsonCors(req, data, 201);
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
        if (body.invoice_photo_url !== undefined) update.invoice_photo_url = body.invoice_photo_url ?? null;
        if (body.due_date !== undefined) update.due_date = body.due_date ?? null;

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

        return jsonCors(req, data);
      }

      if (action === "order-payment") {
        const body = await req.json() as Record<string, unknown>;

        const { data: existing } = await supabaseAdmin.from("supplier_orders").select("business_id").eq("id", id).single();
        if (!existing) return notFound("Order not found");

        const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
        if (ctx instanceof Response) return ctx;

        const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.paid_at !== undefined) update.paid_at = body.paid_at ?? null;
        if (body.due_date !== undefined) update.due_date = body.due_date ?? null;

        const { data, error } = await supabaseAdmin
          .from("supplier_orders")
          .update(update)
          .eq("id", id)
          .select(`*, items:supplier_order_items(*), supplier:suppliers(name)`)
          .single();

        if (error) return serverError(error.message);
        return jsonCors(req, data);
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
        return jsonCors(req, { ok: true });
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
      return jsonCors(req, data);
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    if (method === "DELETE") {
      if (action === "document") {
        if (!id) return badRequest("id is required");

        const { data: existing } = await supabaseAdmin.from("supplier_documents").select("business_id, file_path").eq("id", id).single();
        if (!existing) return notFound("Document not found");

        const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
        if (ctx instanceof Response) return ctx;

        const filePath = (existing as Record<string, unknown>).file_path as string | null;
        if (filePath) {
          await supabaseAdmin.storage.from("supplier-documents").remove([filePath]);
        }

        const { error } = await supabaseAdmin.from("supplier_documents").delete().eq("id", id);
        if (error) return serverError(error.message);
        return jsonCors(req, { ok: true });
      }
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("suppliers error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
