import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const VALID_CATEGORIES = ["tax", "rent", "utilities", "bank_loan", "supplier", "equipment", "other"];
const VALID_STATUSES   = ["active", "paid_off", "disputed", "restructured"];
const VALID_PRIORITIES = ["critical", "high", "medium", "low"];

/**
 * /debts — business debt register + payment log
 *
 * GET  ?business_id=[&status=active]        → list debts (priority order: critical first)
 * GET  ?action=summary&business_id=         → totals, counts, overdue
 * GET  ?action=payments&debt_id=            → payment history for one debt
 * POST body={business_id,...}               → create debt
 * POST ?action=record-payment body={...}    → log payment, reduce balance
 * PATCH ?id= body={...fields}               → update debt
 * DELETE ?id=                               → delete debt (cascades payments)
 */
Deno.serve(withLogging("debts", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url    = new URL(req.url);
  const method = req.method;
  const id     = url.searchParams.get("id");
  const action = url.searchParams.get("action");

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      const debtId     = url.searchParams.get("debt_id");

      // GET payments for a specific debt
      if (action === "payments") {
        if (!debtId) return badRequest("debt_id is required");

        let user;
        try { user = await verifyAuth(req); } catch (e) { return e instanceof Response ? e : forbidden("Auth required"); }

        // resolve business_id from the debt row
        const { data: debt } = await supabaseAdmin
          .from("business_debts")
          .select("business_id")
          .eq("id", debtId)
          .maybeSingle();
        if (!debt) return notFound("Debt not found");

        try { await verifyBusinessMember(user.id, (debt as Record<string,unknown>).business_id as string); }
        catch (e) { return e instanceof Response ? e : forbidden("Access denied"); }

        const { data: payments, error } = await supabaseAdmin
          .from("debt_payments")
          .select("id, debt_id, amount, payment_date, notes, created_at")
          .eq("debt_id", debtId)
          .order("payment_date", { ascending: false });

        if (error) return serverError(error.message);
        return json({ payments: payments ?? [] });
      }

      if (!businessId) return badRequest("business_id is required");

      try {
        const user = await verifyAuth(req);
        await verifyBusinessMember(user.id, businessId);
      } catch (e) {
        return e instanceof Response ? e : forbidden("Auth required");
      }

      // GET summary (totals + overdue count)
      if (action === "summary") {
        const { data: debts, error } = await supabaseAdmin
          .from("business_debts")
          .select("current_balance, monthly_minimum, category, priority, due_date, status")
          .eq("business_id", businessId);

        if (error) return serverError(error.message);

        const today = new Date().toISOString().slice(0, 10);
        const active = (debts ?? []).filter((d) => (d as Record<string,unknown>).status === "active");

        let total_owed = 0;
        let monthly_minimum_total = 0;
        let overdue_count = 0;
        const by_category: Record<string, number> = {};
        const by_priority: Record<string, number> = {};

        for (const d of active) {
          const row = d as Record<string, unknown>;
          const balance = Number(row.current_balance ?? 0);
          total_owed += balance;
          monthly_minimum_total += Number(row.monthly_minimum ?? 0);
          const cat = (row.category as string) ?? "other";
          by_category[cat] = (by_category[cat] ?? 0) + balance;
          const pri = (row.priority as string) ?? "medium";
          by_priority[pri] = (by_priority[pri] ?? 0) + balance;
          if (row.due_date && String(row.due_date) < today) overdue_count++;
        }

        return json({
          total_owed,
          monthly_minimum_total,
          overdue_count,
          active_count: active.length,
          by_category,
          by_priority,
        });
      }

      // GET list of debts
      const statusFilter = url.searchParams.get("status");
      let query = supabaseAdmin
        .from("business_debts")
        .select("*")
        .eq("business_id", businessId);

      if (statusFilter && VALID_STATUSES.includes(statusFilter)) {
        query = query.eq("status", statusFilter);
      }

      // Sort: critical first, then high/medium/low, then by due_date asc nulls last
      const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const { data: debts, error } = await query.order("due_date", { ascending: true, nullsFirst: false });
      if (error) return serverError(error.message);

      const sorted = [...(debts ?? [])].sort((a, b) => {
        const ar = a as Record<string,unknown>;
        const br = b as Record<string,unknown>;
        return (PRIORITY_ORDER[ar.priority as string] ?? 2) - (PRIORITY_ORDER[br.priority as string] ?? 2);
      });

      return json({ debts: sorted });
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (method === "POST") {
      let body: Record<string, unknown> = {};
      try { body = await req.json(); } catch { return badRequest("Invalid JSON body"); }

      // Record payment
      if (action === "record-payment") {
        const debtId    = body.debt_id as string | undefined;
        const amount    = Number(body.amount ?? 0);
        const payDate   = (body.payment_date as string) ?? new Date().toISOString().slice(0, 10);
        const notes     = (body.notes as string | null) ?? null;
        const businessId = body.business_id as string | undefined;

        if (!debtId)    return badRequest("debt_id is required");
        if (!businessId) return badRequest("business_id is required");
        if (amount <= 0) return badRequest("amount must be positive");

        const ctx = await requireOwnerOrManagerCtx(req, businessId);
        if (ctx instanceof Response) return ctx;

        // Verify debt belongs to this business
        const { data: debt, error: debtErr } = await supabaseAdmin
          .from("business_debts")
          .select("id, current_balance, status, business_id")
          .eq("id", debtId)
          .eq("business_id", businessId)
          .maybeSingle();

        if (debtErr) return serverError(debtErr.message);
        if (!debt) return notFound("Debt not found");

        const d = debt as Record<string, unknown>;
        if (d.status === "paid_off") return badRequest("This debt is already paid off");

        // Insert payment — DB trigger reduces current_balance automatically
        const { error: payErr } = await supabaseAdmin
          .from("debt_payments")
          .insert({ debt_id: debtId, business_id: businessId, amount, payment_date: payDate, notes });

        if (payErr) return serverError(payErr.message);

        // Re-fetch the updated debt to return fresh state
        const { data: updated, error: refetchErr } = await supabaseAdmin
          .from("business_debts")
          .select("*")
          .eq("id", debtId)
          .single();

        if (refetchErr) return serverError(refetchErr.message);
        return json({ debt: updated, payment: { debt_id: debtId, amount, payment_date: payDate, notes } });
      }

      // Create debt
      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const creditorName   = String(body.creditor_name ?? "").trim();
      const category       = String(body.category ?? "other");
      const originalAmount = Number(body.original_amount ?? 0);
      const currentBalance = body.current_balance !== undefined ? Number(body.current_balance) : originalAmount;

      if (!creditorName)                         return badRequest("creditor_name is required");
      if (!VALID_CATEGORIES.includes(category))  return badRequest("Invalid category");
      if (originalAmount <= 0)                   return badRequest("original_amount must be positive");
      if (currentBalance < 0)                    return badRequest("current_balance cannot be negative");

      const priority = String(body.priority ?? "medium");
      if (!VALID_PRIORITIES.includes(priority))  return badRequest("Invalid priority");

      const { data: created, error: createErr } = await supabaseAdmin
        .from("business_debts")
        .insert({
          business_id:            businessId,
          creditor_name:          creditorName,
          category,
          description:            (body.description as string | null) ?? null,
          original_amount:        originalAmount,
          current_balance:        currentBalance,
          currency_code:          (body.currency_code as string) ?? "EUR",
          interest_rate:          body.interest_rate != null ? Number(body.interest_rate) : null,
          monthly_minimum:        body.monthly_minimum != null ? Number(body.monthly_minimum) : null,
          due_date:               (body.due_date as string | null) ?? null,
          start_date:             (body.start_date as string) ?? new Date().toISOString().slice(0, 10),
          status:                 "active",
          priority,
          creditor_contact:       (body.creditor_contact as string | null) ?? null,
          notes:                  (body.notes as string | null) ?? null,
          is_interest_deductible: Boolean(body.is_interest_deductible ?? false),
        })
        .select()
        .single();

      if (createErr) return serverError(createErr.message);
      return json(created, 201);
    }

    // ── PATCH ─────────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (!id) return badRequest("id query param is required");

      let body: Record<string, unknown> = {};
      try { body = await req.json(); } catch { return badRequest("Invalid JSON body"); }

      // Resolve business_id from the debt row for auth check
      const { data: existing, error: existErr } = await supabaseAdmin
        .from("business_debts")
        .select("business_id, original_amount")
        .eq("id", id)
        .maybeSingle();

      if (existErr) return serverError(existErr.message);
      if (!existing) return notFound("Debt not found");

      const ex = existing as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, ex.business_id as string);
      if (ctx instanceof Response) return ctx;

      const update: Record<string, unknown> = {};

      if (body.creditor_name !== undefined)         update.creditor_name = String(body.creditor_name).trim();
      if (body.category !== undefined)              update.category = body.category;
      if (body.description !== undefined)           update.description = body.description ?? null;
      if (body.original_amount !== undefined)       update.original_amount = Number(body.original_amount);
      if (body.current_balance !== undefined) {
        const newBal = Number(body.current_balance);
        update.current_balance = Math.max(0, newBal);
        if (newBal <= 0) update.status = "paid_off";
      }
      if (body.currency_code !== undefined)         update.currency_code = body.currency_code;
      if (body.interest_rate !== undefined)         update.interest_rate = body.interest_rate != null ? Number(body.interest_rate) : null;
      if (body.monthly_minimum !== undefined)       update.monthly_minimum = body.monthly_minimum != null ? Number(body.monthly_minimum) : null;
      if (body.due_date !== undefined)              update.due_date = body.due_date ?? null;
      if (body.start_date !== undefined)            update.start_date = body.start_date;
      if (body.status !== undefined && VALID_STATUSES.includes(body.status as string)) update.status = body.status;
      if (body.priority !== undefined && VALID_PRIORITIES.includes(body.priority as string)) update.priority = body.priority;
      if (body.creditor_contact !== undefined)      update.creditor_contact = body.creditor_contact ?? null;
      if (body.notes !== undefined)                 update.notes = body.notes ?? null;
      if (body.is_interest_deductible !== undefined) update.is_interest_deductible = Boolean(body.is_interest_deductible);

      if (Object.keys(update).length === 0) return badRequest("No valid fields to update");

      const { data: updated, error: upErr } = await supabaseAdmin
        .from("business_debts")
        .update(update)
        .eq("id", id)
        .select()
        .single();

      if (upErr) return serverError(upErr.message);
      return json(updated);
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (method === "DELETE") {
      if (!id) return badRequest("id query param is required");

      const { data: existing, error: existErr } = await supabaseAdmin
        .from("business_debts")
        .select("business_id")
        .eq("id", id)
        .maybeSingle();

      if (existErr) return serverError(existErr.message);
      if (!existing) return notFound("Debt not found");

      const ex = existing as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, ex.business_id as string);
      if (ctx instanceof Response) return ctx;

      const { error: delErr } = await supabaseAdmin
        .from("business_debts")
        .delete()
        .eq("id", id);

      if (delErr) return serverError(delErr.message);
      return json({ success: true });
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  } catch (err) {
    console.error("[debts]", err);
    return serverError(err instanceof Error ? err.message : "Unexpected error");
  }
}));
