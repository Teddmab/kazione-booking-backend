import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function csvResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="bank_statement_template.csv"',
    },
  });
}

/** Shift a YYYY-MM-DD string by `days` days. */
function dayOffset(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * /bank-statements — bank statement import and reconciliation
 *
 * GET  ?action=template                           → CSV template (no auth required)
 * GET  ?action=batches&business_id=               → list import batches
 * GET  ?action=transactions&business_id=&from=&to=
 *       [&status=all|reconciled|unreconciled]
 *       [&type=all|credit|debit]
 *       [&batch_id=]
 *       [&page=1&limit=50]                        → paginated transaction list
 * POST ?action=import
 *       body: { business_id, filename?, rows: [{date,description,amount,currency?,reference?}] }
 *       → { batch_id, row_count, auto_reconciled_count }
 * PATCH ?action=transaction&id=
 *       body: { category?, notes?, reconciled_payment_id?, reconciled_expense_id?,
 *               reconciled_fixed_cost_id?, reconciled_debt_payment_id? }
 * DELETE ?id=                                     → delete single transaction
 * DELETE ?action=delete-batch&id=                 → delete entire batch + its transactions
 */
Deno.serve(withLogging("bank-statements", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url    = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");
  const id     = url.searchParams.get("id");

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (method === "GET") {
      // Template — public, no auth
      if (action === "template") {
        const csv = [
          "date,description,amount,currency,reference",
          "2024-01-15,Client payment — Haircut,50.00,EUR,TXN001",
          "2024-01-16,Rent January,-800.00,EUR,TXN002",
          "2024-01-17,Supplier invoice — Products,-120.50,EUR,TXN003",
          "2024-01-18,Loan repayment,-250.00,EUR,TXN004",
        ].join("\n");
        return csvResponse(csv);
      }

      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      // Batches list
      if (action === "batches") {
        const { data, error } = await supabaseAdmin
          .from("bank_import_batches")
          .select("id, filename, row_count, auto_reconciled_count, imported_at")
          .eq("business_id", ctx.businessId)
          .order("imported_at", { ascending: false });

        if (error) return serverError(error.message);
        return json({ batches: data ?? [] });
      }

      // Transactions list
      const from    = url.searchParams.get("from");
      const to      = url.searchParams.get("to");
      const status  = url.searchParams.get("status") ?? "all";
      const type    = url.searchParams.get("type")   ?? "all";
      const batchId = url.searchParams.get("batch_id");
      const page    = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));
      const limit   = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10)));
      const offset  = (page - 1) * limit;

      // deno-lint-ignore no-explicit-any
      let q: any = supabaseAdmin
        .from("bank_transactions")
        .select("*", { count: "exact" })
        .eq("business_id", ctx.businessId)
        .order("date", { ascending: false })
        .order("created_at", { ascending: false })
        .range(offset, offset + limit - 1);

      if (from)    q = q.gte("date", from);
      if (to)      q = q.lte("date", to);
      if (batchId) q = q.eq("import_batch_id", batchId);

      if (type === "credit") q = q.gt("amount", 0);
      if (type === "debit")  q = q.lt("amount", 0);

      if (status === "reconciled") {
        q = q.or(
          "reconciled_payment_id.not.is.null," +
          "reconciled_expense_id.not.is.null," +
          "reconciled_fixed_cost_id.not.is.null," +
          "reconciled_debt_payment_id.not.is.null"
        );
      } else if (status === "unreconciled") {
        q = q
          .is("reconciled_payment_id", null)
          .is("reconciled_expense_id", null)
          .is("reconciled_fixed_cost_id", null)
          .is("reconciled_debt_payment_id", null);
      }

      const { data, error, count } = await q;
      if (error) return serverError(error.message);

      const transactions = (data ?? []).map((t: Record<string, unknown>) => ({
        ...t,
        is_reconciled: (
          t.reconciled_payment_id      !== null ||
          t.reconciled_expense_id      !== null ||
          t.reconciled_fixed_cost_id   !== null ||
          t.reconciled_debt_payment_id !== null
        ),
      }));

      return json({ transactions, total: count ?? 0 });
    }

    // ── POST ?action=import ───────────────────────────────────────────────────
    if (method === "POST" && action === "import") {
      const body = await req.json() as Record<string, unknown>;
      const ctx  = await requireOwnerOrManagerCtx(req, body.business_id as string);
      if (ctx instanceof Response) return ctx;

      const rows = body.rows as Array<Record<string, unknown>>;
      if (!Array.isArray(rows) || rows.length === 0) {
        return badRequest("rows must be a non-empty array");
      }

      // Create batch record first
      const { data: batch, error: batchErr } = await supabaseAdmin
        .from("bank_import_batches")
        .insert({
          business_id: ctx.businessId,
          filename:    body.filename ? String(body.filename) : null,
          row_count:   rows.length,
        })
        .select("id")
        .single();

      if (batchErr) return serverError(batchErr.message);

      // Gather already-reconciled IDs from existing bank_transactions
      const [pIds, eIds, fcIds, dpIds] = await Promise.all([
        supabaseAdmin.from("bank_transactions").select("reconciled_payment_id").eq("business_id", ctx.businessId).not("reconciled_payment_id", "is", null),
        supabaseAdmin.from("bank_transactions").select("reconciled_expense_id").eq("business_id", ctx.businessId).not("reconciled_expense_id", "is", null),
        supabaseAdmin.from("bank_transactions").select("reconciled_fixed_cost_id").eq("business_id", ctx.businessId).not("reconciled_fixed_cost_id", "is", null),
        supabaseAdmin.from("bank_transactions").select("reconciled_debt_payment_id").eq("business_id", ctx.businessId).not("reconciled_debt_payment_id", "is", null),
      ]);

      const usedPaymentIds  = new Set((pIds.data  ?? []).map((r) => r.reconciled_payment_id  as string));
      const usedExpenseIds  = new Set((eIds.data  ?? []).map((r) => r.reconciled_expense_id  as string));
      const usedFcIds       = new Set((fcIds.data ?? []).map((r) => r.reconciled_fixed_cost_id as string));
      const usedDpIds       = new Set((dpIds.data ?? []).map((r) => r.reconciled_debt_payment_id as string));

      // Process rows and auto-reconcile
      const insertRows: Record<string, unknown>[] = [];
      let autoReconciledCount = 0;

      for (const row of rows) {
        const amount   = Number(row.amount ?? 0);
        const dateStr  = String(row.date ?? "");
        const dayBefore = dayOffset(dateStr, -1);
        const dayAfter  = dayOffset(dateStr, 1);

        let reconciled_payment_id:      string | null = null;
        let reconciled_expense_id:      string | null = null;
        let reconciled_fixed_cost_id:   string | null = null;
        let reconciled_debt_payment_id: string | null = null;

        if (amount > 0) {
          // Credit → match payments
          const { data: pMatches } = await supabaseAdmin
            .from("payments")
            .select("id, amount")
            .eq("business_id", ctx.businessId)
            .eq("status", "paid")
            .gte("paid_at", dayBefore + "T00:00:00.000Z")
            .lte("paid_at", dayAfter  + "T23:59:59.999Z");

          const pMatch = (pMatches ?? []).find((m) =>
            Math.abs(Number(m.amount) - amount) < 0.01 && !usedPaymentIds.has(m.id)
          );
          if (pMatch) {
            reconciled_payment_id = pMatch.id;
            usedPaymentIds.add(pMatch.id);
            autoReconciledCount++;
          }

        } else if (amount < 0) {
          const absAmt = Math.abs(amount);

          // 1. Try expenses
          const { data: eMatches } = await supabaseAdmin
            .from("expenses")
            .select("id, amount")
            .eq("business_id", ctx.businessId)
            .gte("date", dayBefore)
            .lte("date", dayAfter);

          const eMatch = (eMatches ?? []).find((m) =>
            Math.abs(Number(m.amount) - absAmt) < 0.01 && !usedExpenseIds.has(m.id)
          );
          if (eMatch) {
            reconciled_expense_id = eMatch.id;
            usedExpenseIds.add(eMatch.id);
            autoReconciledCount++;
          } else {
            // 2. Try fixed_costs (only if paid_at is set)
            const { data: fcMatches } = await supabaseAdmin
              .from("fixed_costs")
              .select("id, amount")
              .eq("business_id", ctx.businessId)
              .not("paid_at", "is", null)
              .gte("paid_at", dayBefore + "T00:00:00.000Z")
              .lte("paid_at", dayAfter  + "T23:59:59.999Z");

            const fcMatch = (fcMatches ?? []).find((m) =>
              Math.abs(Number(m.amount) - absAmt) < 0.01 && !usedFcIds.has(m.id)
            );
            if (fcMatch) {
              reconciled_fixed_cost_id = fcMatch.id;
              usedFcIds.add(fcMatch.id);
              autoReconciledCount++;
            } else {
              // 3. Try debt_payments
              const { data: dpMatches } = await supabaseAdmin
                .from("debt_payments")
                .select("id, amount")
                .eq("business_id", ctx.businessId)
                .gte("payment_date", dayBefore)
                .lte("payment_date", dayAfter);

              const dpMatch = (dpMatches ?? []).find((m) =>
                Math.abs(Number(m.amount) - absAmt) < 0.01 && !usedDpIds.has(m.id)
              );
              if (dpMatch) {
                reconciled_debt_payment_id = dpMatch.id;
                usedDpIds.add(dpMatch.id);
                autoReconciledCount++;
              }
            }
          }
        }

        insertRows.push({
          business_id:                ctx.businessId,
          import_batch_id:            batch.id,
          date:                       dateStr,
          description:                String(row.description ?? "").trim(),
          amount,
          currency_code:              String(row.currency ?? row.currency_code ?? "EUR"),
          reference:                  row.reference ? String(row.reference).trim() : null,
          reconciled_payment_id,
          reconciled_expense_id,
          reconciled_fixed_cost_id,
          reconciled_debt_payment_id,
        });
      }

      const { error: insertErr } = await supabaseAdmin
        .from("bank_transactions")
        .insert(insertRows);

      if (insertErr) {
        // Roll back batch header
        await supabaseAdmin.from("bank_import_batches").delete().eq("id", batch.id);
        return serverError(insertErr.message);
      }

      // Update batch with final auto-reconciled count
      await supabaseAdmin
        .from("bank_import_batches")
        .update({ auto_reconciled_count: autoReconciledCount })
        .eq("id", batch.id);

      return json({ batch_id: batch.id, row_count: rows.length, auto_reconciled_count: autoReconciledCount }, 201);
    }

    // ── POST ?action=auto-create-expenses ─────────────────────────────────────
    // For each unmatched debit in a batch, create an expense record and link it.
    if (method === "POST" && action === "auto-create-expenses") {
      let body: Record<string, unknown> = {};
      try { body = await req.json(); } catch { return badRequest("Invalid JSON body"); }

      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
      if (ctx instanceof Response) return ctx;

      const batchId = body.batch_id as string | undefined;
      if (!batchId) return badRequest("batch_id is required");

      // Fetch unmatched debits belonging to this batch
      const { data: txs, error: txErr } = await supabaseAdmin
        .from("bank_transactions")
        .select("id, date, description, amount, currency_code")
        .eq("import_batch_id", batchId)
        .eq("business_id", ctx.businessId)
        .lt("amount", 0)
        .is("reconciled_payment_id", null)
        .is("reconciled_expense_id", null)
        .is("reconciled_fixed_cost_id", null)
        .is("reconciled_debt_payment_id", null);

      if (txErr) return serverError(txErr.message);

      let createdCount = 0;
      for (const rawTx of txs ?? []) {
        const tx = rawTx as Record<string, unknown>;
        const { data: expense, error: expErr } = await supabaseAdmin
          .from("expenses")
          .insert({
            business_id: ctx.businessId,
            category: "other",
            description: String(tx.description ?? "").slice(0, 255),
            amount: Math.abs(Number(tx.amount)),
            currency_code: String(tx.currency_code ?? "EUR"),
            tax_amount: 0,
            tax_rate: 0,
            date: String(tx.date).slice(0, 10),
            is_recurring: false,
            notes: "Auto-created from bank statement import",
          })
          .select("id")
          .single();

        if (expErr || !expense) continue;

        await supabaseAdmin
          .from("bank_transactions")
          .update({ reconciled_expense_id: (expense as Record<string, unknown>).id })
          .eq("id", String(tx.id));

        createdCount++;
      }

      return json({ created_count: createdCount });
    }

    // ── PATCH ?action=transaction&id= ─────────────────────────────────────────
    if (method === "PATCH" && action === "transaction") {
      if (!id) return badRequest("id is required");

      const { data: existing, error: existErr } = await supabaseAdmin
        .from("bank_transactions")
        .select("business_id")
        .eq("id", id)
        .maybeSingle();

      if (existErr) return serverError(existErr.message);
      if (!existing) return notFound("Transaction not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const body = await req.json() as Record<string, unknown>;
      const update: Record<string, unknown> = {};

      if (body.category  !== undefined) update.category  = body.category  ?? null;
      if (body.notes     !== undefined) update.notes     = body.notes     ?? null;
      if (body.reconciled_payment_id      !== undefined) update.reconciled_payment_id      = body.reconciled_payment_id      ?? null;
      if (body.reconciled_expense_id      !== undefined) update.reconciled_expense_id      = body.reconciled_expense_id      ?? null;
      if (body.reconciled_fixed_cost_id   !== undefined) update.reconciled_fixed_cost_id   = body.reconciled_fixed_cost_id   ?? null;
      if (body.reconciled_debt_payment_id !== undefined) update.reconciled_debt_payment_id = body.reconciled_debt_payment_id ?? null;

      if (Object.keys(update).length === 0) return badRequest("No valid fields to update");

      const { data: updated, error } = await supabaseAdmin
        .from("bank_transactions")
        .update(update)
        .eq("id", id)
        .select()
        .single();

      if (error) return serverError(error.message);

      const t = updated as Record<string, unknown>;
      return json({
        ...t,
        is_reconciled: (
          t.reconciled_payment_id      !== null ||
          t.reconciled_expense_id      !== null ||
          t.reconciled_fixed_cost_id   !== null ||
          t.reconciled_debt_payment_id !== null
        ),
      });
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (method === "DELETE") {
      // Delete entire batch
      if (action === "delete-batch") {
        if (!id) return badRequest("id is required");

        const { data: existing, error: existErr } = await supabaseAdmin
          .from("bank_import_batches")
          .select("business_id")
          .eq("id", id)
          .maybeSingle();

        if (existErr) return serverError(existErr.message);
        if (!existing) return notFound("Batch not found");

        const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
        if (ctx instanceof Response) return ctx;

        // Cascade delete via FK (bank_transactions.import_batch_id ON DELETE CASCADE)
        const { error } = await supabaseAdmin.from("bank_import_batches").delete().eq("id", id);
        if (error) return serverError(error.message);
        return json({ success: true });
      }

      // Delete single transaction
      if (!id) return badRequest("id is required");

      const { data: existing, error: existErr } = await supabaseAdmin
        .from("bank_transactions")
        .select("business_id")
        .eq("id", id)
        .maybeSingle();

      if (existErr) return serverError(existErr.message);
      if (!existing) return notFound("Transaction not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const { error } = await supabaseAdmin.from("bank_transactions").delete().eq("id", id);
      if (error) return serverError(error.message);
      return json({ success: true });
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[bank-statements]", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
