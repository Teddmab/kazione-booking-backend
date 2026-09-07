import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, conflict, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { monthKeyOf } from "../_shared/financialPeriods.ts";

const MONTH_RE = /^\d{4}-\d{2}$/;

function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(y, m, 0).getDate(); // m is 1-based here → last day of that month
  return { from: `${month}-01`, to: `${month}-${String(lastDay).padStart(2, "0")}` };
}

/**
 * /financial-periods — per-business-per-month bookkeeping lock + live-computed readiness
 *
 * GET  ?action=status&business_id=&month=YYYY-MM  → lock status + checklist counts
 * GET  ?action=year-status&business_id=&year=YYYY → per-month readiness across a year
 * POST ?action=close  body={business_id, month, note?}    → close the month
 * POST ?action=reopen body={business_id, month, reason?}  → reopen the month
 */
Deno.serve(withLogging("financial-periods", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    if (req.method === "GET" && action === "status") {
      const businessId = url.searchParams.get("business_id");
      const month = url.searchParams.get("month");
      if (!businessId) return badRequest(req, "business_id is required");
      if (!month || !MONTH_RE.test(month)) return badRequest(req, "month must be YYYY-MM");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { from, to } = monthBounds(month);
      const periodMonth = monthKeyOf(from);

      const [
        periodRes, unreconciledRes, uncategorizedRes, missingReceiptRes,
        needingAttentionRes, totalTransactionsRes, totalExpensesRes,
      ] = await Promise.all([
        supabaseAdmin.from("financial_periods").select("*")
          .eq("business_id", ctx.businessId).eq("period_month", periodMonth).maybeSingle(),
        supabaseAdmin.from("bank_transactions").select("id", { count: "exact", head: true })
          .eq("business_id", ctx.businessId).gte("date", from).lte("date", to)
          .is("reconciled_payment_id", null).is("reconciled_expense_id", null)
          .is("reconciled_fixed_cost_id", null).is("reconciled_debt_payment_id", null)
          .is("reconciled_appointment_id", null).is("reconciled_stock_movement_id", null),
        supabaseAdmin.from("bank_transactions").select("id", { count: "exact", head: true })
          .eq("business_id", ctx.businessId).gte("date", from).lte("date", to).is("category", null),
        supabaseAdmin.from("expenses").select("id", { count: "exact", head: true })
          .eq("business_id", ctx.businessId).gte("date", from).lte("date", to).is("receipt_url", null),
        // Distinct count of transactions that are unreconciled OR uncategorized —
        // used wherever a single "needs attention" figure is shown (e.g. VAT
        // blocking), since summing the two counts above can double-count a
        // transaction that is both.
        supabaseAdmin.from("bank_transactions").select("id", { count: "exact", head: true })
          .eq("business_id", ctx.businessId).gte("date", from).lte("date", to)
          .or(
            "and(reconciled_payment_id.is.null,reconciled_expense_id.is.null,reconciled_fixed_cost_id.is.null,reconciled_debt_payment_id.is.null,reconciled_appointment_id.is.null,reconciled_stock_movement_id.is.null),category.is.null",
          ),
        supabaseAdmin.from("bank_transactions").select("id", { count: "exact", head: true })
          .eq("business_id", ctx.businessId).gte("date", from).lte("date", to),
        supabaseAdmin.from("expenses").select("id", { count: "exact", head: true })
          .eq("business_id", ctx.businessId).gte("date", from).lte("date", to),
      ]);
      if (periodRes.error) return serverError(req, periodRes.error.message);
      if (unreconciledRes.error) return serverError(req, unreconciledRes.error.message);
      if (uncategorizedRes.error) return serverError(req, uncategorizedRes.error.message);
      if (missingReceiptRes.error) return serverError(req, missingReceiptRes.error.message);
      if (needingAttentionRes.error) return serverError(req, needingAttentionRes.error.message);
      if (totalTransactionsRes.error) return serverError(req, totalTransactionsRes.error.message);
      if (totalExpensesRes.error) return serverError(req, totalExpensesRes.error.message);

      const period = periodRes.data as Record<string, unknown> | null;
      const checklist = {
        unreconciled_transactions: unreconciledRes.count ?? 0,
        uncategorized_transactions: uncategorizedRes.count ?? 0,
        expenses_missing_receipt: missingReceiptRes.count ?? 0,
      };
      return jsonCors(req, {
        month,
        status: (period?.status as string) ?? "open",
        closed_at: period?.closed_at ?? null,
        closed_by: period?.closed_by ?? null,
        close_note: period?.close_note ?? null,
        reopened_at: period?.reopened_at ?? null,
        checklist,
        transactions_needing_attention: needingAttentionRes.count ?? 0,
        totals: {
          transactions: totalTransactionsRes.count ?? 0,
          expenses: totalExpensesRes.count ?? 0,
        },
        ready: Object.values(checklist).every((n) => n === 0),
      });
    }

    if (req.method === "GET" && action === "year-status") {
      const businessId = url.searchParams.get("business_id");
      const year = parseInt(url.searchParams.get("year") ?? "", 10);
      if (!businessId) return badRequest(req, "business_id is required");
      if (!year) return badRequest(req, "year is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const yearStart = `${year}-01-01`;
      const yearEnd = `${year + 1}-01-01`;

      const [bankRes, expenseRes] = await Promise.all([
        supabaseAdmin.from("bank_transactions")
          .select("date, category, reconciled_payment_id, reconciled_expense_id, reconciled_fixed_cost_id, reconciled_debt_payment_id, reconciled_appointment_id, reconciled_stock_movement_id")
          .eq("business_id", ctx.businessId).gte("date", yearStart).lt("date", yearEnd),
        supabaseAdmin.from("expenses")
          .select("date, receipt_url")
          .eq("business_id", ctx.businessId).gte("date", yearStart).lt("date", yearEnd),
      ]);
      if (bankRes.error) return serverError(req, bankRes.error.message);
      if (expenseRes.error) return serverError(req, expenseRes.error.message);

      const buckets: Record<number, { unreconciled: number; uncategorized: number; missingReceipt: number }> = {};
      for (let m = 1; m <= 12; m++) buckets[m] = { unreconciled: 0, uncategorized: 0, missingReceipt: 0 };

      for (const tx of bankRes.data ?? []) {
        const t = tx as Record<string, unknown>;
        const m = new Date(t.date as string).getUTCMonth() + 1;
        const isUnreconciled = !t.reconciled_payment_id && !t.reconciled_expense_id && !t.reconciled_fixed_cost_id &&
          !t.reconciled_debt_payment_id && !t.reconciled_appointment_id && !t.reconciled_stock_movement_id;
        if (isUnreconciled) buckets[m].unreconciled += 1;
        if (t.category == null) buckets[m].uncategorized += 1;
      }
      for (const e of expenseRes.data ?? []) {
        const t = e as Record<string, unknown>;
        const m = new Date(t.date as string).getUTCMonth() + 1;
        if (t.receipt_url == null) buckets[m].missingReceipt += 1;
      }

      const now = new Date();
      const currentMonthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
      const months = Array.from({ length: 12 }, (_, i) => {
        const m = i + 1;
        const b = buckets[m];
        const isPast = year * 12 + (m - 1) < currentMonthIndex;
        const clean = b.unreconciled === 0 && b.uncategorized === 0 && b.missingReceipt === 0;
        return { month: `${year}-${String(m).padStart(2, "0")}`, is_past: isPast, clean, ready: isPast && clean };
      });

      return jsonCors(req, {
        year,
        months,
        ready_count: months.filter((mo) => mo.ready).length,
        total_count: months.length,
      });
    }

    if (req.method === "POST" && (action === "close" || action === "reopen")) {
      let body: Record<string, unknown> = {};
      try { body = await req.json(); } catch { return badRequest(req, "Invalid JSON body"); }

      const month = body.month as string | undefined;
      if (!month || !MONTH_RE.test(month)) return badRequest(req, "month must be YYYY-MM");

      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string | undefined);
      if (ctx instanceof Response) return ctx;

      const periodMonth = monthKeyOf(`${month}-01`);
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("financial_periods")
        .select("*")
        .eq("business_id", ctx.businessId)
        .eq("period_month", periodMonth)
        .maybeSingle();
      if (fetchErr) return serverError(req, fetchErr.message);
      const currentStatus = (existing as Record<string, unknown> | null)?.status ?? "open";

      if (action === "close") {
        if (currentStatus === "closed") return conflict(req, "ALREADY_CLOSED", `${month} is already closed`);
        const { data, error } = await supabaseAdmin.from("financial_periods")
          .upsert({
            business_id: ctx.businessId,
            period_month: periodMonth,
            status: "closed",
            closed_at: new Date().toISOString(),
            closed_by: ctx.userId,
            close_note: (body.note as string | null) ?? null,
            reopened_at: null,
            reopened_by: null,
            reopen_reason: null,
          }, { onConflict: "business_id,period_month" })
          .select().single();
        if (error) return serverError(req, error.message);
        return jsonCors(req, data, 201);
      }

      // action === "reopen"
      if (currentStatus !== "closed") return conflict(req, "ALREADY_OPEN", `${month} is not currently closed`);
      const { data, error } = await supabaseAdmin.from("financial_periods")
        .update({
          status: "open",
          reopened_at: new Date().toISOString(),
          reopened_by: ctx.userId,
          reopen_reason: (body.reason as string | null) ?? null,
        })
        .eq("id", (existing as Record<string, unknown>).id)
        .select().single();
      if (error) return serverError(req, error.message);
      return jsonCors(req, data);
    }

    return badRequest(req, "Unknown action");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[financial-periods]", err);
    return serverError(req, err instanceof Error ? err.message : "Internal error");
  }
}));
