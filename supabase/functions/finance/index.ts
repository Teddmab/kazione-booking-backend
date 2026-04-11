import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * /finance — finance analytics, expense CRUD, bookkeeping
 *
 * GET  ?action=revenue&business_id=&from=&to=
 * GET  ?action=income&business_id=&from=&to=[&group_by=day|week|month]
 * GET  ?action=expenses&business_id=&[page=&limit=&category=&supplier_id=&date_from=&date_to=&search=]
 * GET  ?action=expense-breakdown&business_id=&from=&to=
 * GET  ?action=tax-summary&business_id=&year=[&quarter=]
 * GET  ?action=bookkeeping&business_id=&from=&to=
 * GET  ?action=staff-performance&business_id=&from=&to=
 * GET  ?action=supplier-spend&business_id=&from=&to=
 * POST ?action=expense        → create expense (body: business_id + fields, no file upload)
 * PATCH ?action=expense&id=   → update expense
 * DELETE ?id=                 → delete expense
 */
Deno.serve(withLogging("finance", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      if (action === "revenue") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");
        const { data, error } = await supabaseAdmin.rpc("get_revenue_summary", {
          p_business_id: businessId, p_start_date: from, p_end_date: to,
        });
        if (error) return serverError(error.message);
        return json(data);
      }

      if (action === "income") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");
        const groupBy = url.searchParams.get("group_by") ?? "month";
        const { data, error } = await supabaseAdmin.rpc("get_income_breakdown", {
          p_business_id: businessId, p_start_date: from, p_end_date: to, p_group_by: groupBy,
        });
        if (error) return serverError(error.message);
        return json(data ?? []);
      }

      if (action === "expenses" || !action) {
        const page = parseInt(url.searchParams.get("page") ?? "1", 10);
        const limit = parseInt(url.searchParams.get("limit") ?? "25", 10);
        const category = url.searchParams.get("category");
        const supplierId = url.searchParams.get("supplier_id");
        const dateFrom = url.searchParams.get("date_from");
        const dateTo = url.searchParams.get("date_to");
        const search = url.searchParams.get("search");

        // deno-lint-ignore no-explicit-any
        let query: any = supabaseAdmin
          .from("expenses")
          .select(`*, supplier:suppliers(id, name)`, { count: "exact" })
          .eq("business_id", businessId)
          .order("date", { ascending: false });

        if (category) query = query.eq("category", category);
        if (supplierId) query = query.eq("supplier_id", supplierId);
        if (dateFrom) query = query.gte("date", dateFrom);
        if (dateTo) query = query.lte("date", dateTo);
        if (search) query = query.ilike("description", `%${search}%`);

        const from = (page - 1) * limit;
        query = query.range(from, from + limit - 1);

        const { data, error, count } = await query;
        if (error) return serverError(error.message);

        return json({
          expenses: (data ?? []).map((row: Record<string, unknown>) => ({ ...row, supplier: row.supplier ?? null })),
          total: count ?? 0,
        });
      }

      if (action === "expense-breakdown") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");
        const { data, error } = await supabaseAdmin.rpc("get_expense_breakdown", {
          p_business_id: businessId, p_start_date: from, p_end_date: to,
        });
        if (error) return serverError(error.message);
        return json(data ?? []);
      }

      if (action === "tax-summary") {
        const year = parseInt(url.searchParams.get("year") ?? "0", 10);
        if (!year) return badRequest("year is required");
        const quarter = url.searchParams.get("quarter");
        const { data, error } = await supabaseAdmin.rpc("get_tax_summary", {
          p_business_id: businessId,
          p_year: year,
          p_quarter: quarter ? parseInt(quarter, 10) : null,
        });
        if (error) return serverError(error.message);
        return json(data);
      }

      if (action === "bookkeeping") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");

        const [paymentsResult, expensesResult] = await Promise.all([
          supabaseAdmin
            .from("payments")
            .select(`id, amount, tax_amount, paid_at, method, appointment:appointments!inner(booking_reference, service:services!inner(name))`)
            .eq("business_id", businessId)
            .eq("status", "succeeded")
            .gte("paid_at", from)
            .lte("paid_at", to),
          supabaseAdmin
            .from("expenses")
            .select("id, amount, tax_amount, date, description, category")
            .eq("business_id", businessId)
            .gte("date", from)
            .lte("date", to),
        ]);

        if (paymentsResult.error) return serverError(paymentsResult.error.message);
        if (expensesResult.error) return serverError(expensesResult.error.message);

        const incomeRows = (paymentsResult.data ?? []).map((p: Record<string, unknown>) => {
          const appt = p.appointment as Record<string, unknown> | null;
          const svc = appt?.service as Record<string, unknown> | null;
          return {
            date: p.paid_at,
            type: "income" as const,
            description: `Payment – ${svc?.name ?? "Service"} (${appt?.booking_reference ?? ""})`,
            category: p.method ?? "card",
            amount: Number(p.amount),
            tax_amount: Number(p.tax_amount ?? 0),
          };
        });

        const expenseRows = (expensesResult.data ?? []).map((e: Record<string, unknown>) => ({
          date: e.date,
          type: "expense" as const,
          description: e.description,
          category: e.category,
          amount: Number(e.amount),
          tax_amount: Number(e.tax_amount ?? 0),
        }));

        const merged = [...incomeRows, ...expenseRows].sort(
          (a, b) => new Date(a.date as string).getTime() - new Date(b.date as string).getTime(),
        );

        let balance = 0;
        const transactions = merged.map((row) => {
          balance += row.type === "income" ? row.amount : -row.amount;
          return { ...row, running_balance: Math.round(balance * 100) / 100 };
        });

        return json(transactions);
      }

      if (action === "staff-performance") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");
        const { data, error } = await supabaseAdmin.rpc("get_staff_performance", {
          p_business_id: businessId, p_start_date: from, p_end_date: to,
        });
        if (error) return serverError(error.message);
        return json(data ?? []);
      }

      if (action === "supplier-spend") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");
        const { data, error } = await supabaseAdmin.rpc("get_supplier_spend", {
          p_business_id: businessId, p_start_date: from, p_end_date: to,
        });
        if (error) return serverError(error.message);
        return json(data ?? []);
      }

      return badRequest(`Unknown action: ${action}`);
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (method === "POST" && action === "expense") {
      const body = await req.json() as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
      if (ctx instanceof Response) return ctx;

      const { data: expense, error } = await supabaseAdmin
        .from("expenses")
        .insert({
          business_id: ctx.businessId,
          supplier_id: body.supplier_id ?? null,
          category: body.category,
          description: body.description,
          amount: body.amount,
          currency_code: body.currency_code ?? "EUR",
          tax_amount: body.tax_amount ?? 0,
          tax_rate: body.tax_rate ?? 0,
          receipt_url: null, // file uploads handled via separate presigned URL endpoint
          date: body.date,
          is_recurring: body.is_recurring ?? false,
          recurrence_rule: body.recurrence_rule ?? null,
          recurrence_end_date: body.recurrence_end_date ?? null,
          notes: body.notes ?? null,
        })
        .select(`*, supplier:suppliers(id, name)`)
        .single();

      if (error) return serverError(error.message);
      return json({ ...expense, supplier: (expense as Record<string, unknown>).supplier ?? null }, 201);
    }

    // ── PATCH ──────────────────────────────────────────────────────────────
    if (method === "PATCH" && action === "expense") {
      const id = url.searchParams.get("id");
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;

      // Fetch expense to get business_id
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("expenses")
        .select("business_id")
        .eq("id", id)
        .single();

      if (fetchErr || !existing) return badRequest("Expense not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const { data: expense, error } = await supabaseAdmin
        .from("expenses")
        .update(body)
        .eq("id", id)
        .select(`*, supplier:suppliers(id, name)`)
        .single();

      if (error) return serverError(error.message);
      return json({ ...expense, supplier: (expense as Record<string, unknown>).supplier ?? null });
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    if (method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) return badRequest("id is required");

      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("expenses")
        .select("business_id")
        .eq("id", id)
        .single();

      if (fetchErr || !existing) return badRequest("Expense not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const { error } = await supabaseAdmin.from("expenses").delete().eq("id", id);
      if (error) return serverError(error.message);
      return json(null, 204);
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("finance error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
