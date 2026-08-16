import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";

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
 * GET  ?action=annual-summary&business_id=&year=YYYY
 * GET  ?action=bank-coverage&business_id=&year=YYYY
 * GET  ?action=payroll-summary&business_id=&year=YYYY
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
        return jsonCors(req, data);
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
        return jsonCors(req, data ?? []);
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

        return jsonCors(req, {
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
        return jsonCors(req, data ?? []);
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
        return jsonCors(req, data);
      }

      if (action === "bookkeeping") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");

        const [paymentsResult, expensesResult, fixedCostsResult, debtPaymentsResult] = await Promise.all([
          supabaseAdmin
            .from("payments")
            .select(`id, amount, tax_amount, paid_at, method, appointment:appointments!inner(booking_reference, service:services!inner(name))`)
            .eq("business_id", businessId)
            .eq("status", "paid")
            .gte("paid_at", from)
            .lte("paid_at", to),
          supabaseAdmin
            .from("expenses")
            .select("id, amount, tax_amount, date, description, category")
            .eq("business_id", businessId)
            .gte("date", from)
            .lte("date", to),
          supabaseAdmin
            .from("fixed_costs")
            .select("id, amount, cost_date, name, category")
            .eq("business_id", businessId)
            .gte("cost_date", from)
            .lte("cost_date", to),
          supabaseAdmin
            .from("debt_payments")
            .select("id, amount, payment_date, notes, debt:business_debts(creditor_name)")
            .eq("business_id", businessId)
            .gte("payment_date", from)
            .lte("payment_date", to),
        ]);

        if (paymentsResult.error)     return serverError(paymentsResult.error.message);
        if (expensesResult.error)     return serverError(expensesResult.error.message);
        if (fixedCostsResult.error)   return serverError(fixedCostsResult.error.message);
        if (debtPaymentsResult.error) return serverError(debtPaymentsResult.error.message);

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

        const fixedCostRows = (fixedCostsResult.data ?? []).map((fc: Record<string, unknown>) => ({
          date: fc.cost_date,
          type: "expense" as const,
          description: fc.name ?? "Fixed cost",
          category: fc.category ?? "fixed_cost",
          amount: Number(fc.amount),
          tax_amount: 0,
        }));

        const debtPaymentRows = (debtPaymentsResult.data ?? []).map((dp: Record<string, unknown>) => {
          const debt = dp.debt as Record<string, unknown> | null;
          return {
            date: dp.payment_date,
            type: "expense" as const,
            description: `Debt repayment – ${debt?.creditor_name ?? "Creditor"}`,
            category: "debt_payment",
            amount: Number(dp.amount),
            tax_amount: 0,
          };
        });

        const merged = [...incomeRows, ...expenseRows, ...fixedCostRows, ...debtPaymentRows].sort(
          (a, b) => new Date(a.date as string).getTime() - new Date(b.date as string).getTime(),
        );

        let balance = 0;
        const transactions = merged.map((row) => {
          balance += row.type === "income" ? row.amount : -row.amount;
          return { ...row, running_balance: Math.round(balance * 100) / 100 };
        });

        return jsonCors(req, transactions);
      }

      if (action === "staff-performance") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");
        const { data, error } = await supabaseAdmin.rpc("get_staff_performance", {
          p_business_id: businessId, p_start_date: from, p_end_date: to,
        });
        if (error) return serverError(error.message);
        return jsonCors(req, data ?? []);
      }

      if (action === "supplier-spend") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return badRequest("from and to are required");
        const { data, error } = await supabaseAdmin.rpc("get_supplier_spend", {
          p_business_id: businessId, p_start_date: from, p_end_date: to,
        });
        if (error) return serverError(error.message);
        return jsonCors(req, data ?? []);
      }

      if (action === "annual-summary") {
        const year = parseInt(url.searchParams.get("year") ?? "0", 10);
        if (!year) return badRequest("year is required");

        const yearStart = `${year}-01-01`;
        const yearEnd = `${year + 1}-01-01`;

        const [apptResult, paymentResult, expenseResult, commPaidResult] = await Promise.all([
          supabaseAdmin
            .from("appointments")
            .select("price, starts_at")
            .eq("business_id", businessId)
            .eq("status", "completed")
            .is("deleted_at", null)
            .gte("starts_at", yearStart)
            .lt("starts_at", yearEnd),
          supabaseAdmin
            .from("payments")
            .select("amount, tax_amount, paid_at")
            .eq("business_id", businessId)
            .eq("status", "paid")
            .gte("paid_at", yearStart)
            .lt("paid_at", yearEnd),
          supabaseAdmin
            .from("expenses")
            .select("amount, tax_amount, date, receipt_url")
            .eq("business_id", businessId)
            .gte("date", yearStart)
            .lt("date", yearEnd),
          supabaseAdmin
            .from("appointments")
            .select("commission_amount_paid")
            .eq("business_id", businessId)
            .eq("status", "completed")
            .not("commission_paid_at", "is", null)
            .gte("commission_paid_at", yearStart)
            .lt("commission_paid_at", yearEnd),
        ]);

        if (apptResult.error)    return serverError(apptResult.error.message);
        if (paymentResult.error) return serverError(paymentResult.error.message);
        if (expenseResult.error) return serverError(expenseResult.error.message);
        if (commPaidResult.error) return serverError(commPaidResult.error.message);

        // Revenue by month (gross from appointments, vat from payments)
        const revByMonth: Record<number, { gross: number; vat: number }> = {};
        for (let m = 1; m <= 12; m++) revByMonth[m] = { gross: 0, vat: 0 };
        for (const a of apptResult.data ?? []) {
          const m = new Date(a.starts_at as string).getMonth() + 1;
          revByMonth[m].gross += Number(a.price ?? 0);
        }
        for (const p of paymentResult.data ?? []) {
          const m = new Date(p.paid_at as string).getMonth() + 1;
          revByMonth[m].vat += Number(p.tax_amount ?? 0);
        }
        const totalGross = Object.values(revByMonth).reduce((s, v) => s + v.gross, 0);
        const totalVat   = Object.values(revByMonth).reduce((s, v) => s + v.vat, 0);

        // Expenses by month
        const expByMonth: Record<number, { total: number; count: number; missing_invoices: number }> = {};
        for (let m = 1; m <= 12; m++) expByMonth[m] = { total: 0, count: 0, missing_invoices: 0 };
        let totalExpenses = 0;
        let totalVatDeductible = 0;
        let missingInvoiceCount = 0;
        for (const e of expenseResult.data ?? []) {
          const m = new Date(e.date as string).getMonth() + 1;
          const amt = Number(e.amount ?? 0);
          const tax = Number(e.tax_amount ?? 0);
          expByMonth[m].total += amt;
          expByMonth[m].count += 1;
          totalExpenses += amt;
          totalVatDeductible += tax;
          if (!e.receipt_url) { expByMonth[m].missing_invoices += 1; missingInvoiceCount += 1; }
        }

        // Commissions paid this year
        const commissionsPaid = (commPaidResult.data ?? []).reduce(
          (s, a) => s + Number(a.commission_amount_paid ?? 0), 0,
        );

        // Unpaid commissions (need service join)
        const { data: bizRow } = await supabaseAdmin
          .from("businesses").select("commission_rate").eq("id", businessId).maybeSingle();
        const bizRate = Number((bizRow as Record<string, unknown> | null)?.commission_rate ?? 0);

        const { data: unpaidAppts, error: unpaidErr } = await supabaseAdmin
          .from("appointments")
          .select("price, service:services(staff_commission_type, staff_commission_value)")
          .eq("business_id", businessId)
          .eq("status", "completed")
          .is("commission_paid_at", null)
          .is("deleted_at", null);
        if (unpaidErr) return serverError(unpaidErr.message);

        let commissionsUnpaid = 0;
        for (const a of unpaidAppts ?? []) {
          const svc = (a as Record<string, unknown>).service as Record<string, unknown> | null;
          const price = Number(a.price ?? 0);
          const commType = (svc?.staff_commission_type as string) ?? "none";
          const commVal = Number(svc?.staff_commission_value ?? 0);
          let commAmt = 0;
          if (commType === "percentage") commAmt = (price * commVal) / 100;
          else if (commType === "fixed") commAmt = commVal;
          else commAmt = (price * bizRate) / 100;
          commissionsUnpaid += Math.max(0, commAmt);
        }

        const r = (n: number) => Math.round(n * 100) / 100;
        const netRevenue  = r(totalGross - totalVat);
        const netExpenses = r(totalExpenses - totalVatDeductible);
        const netProfit   = r(netRevenue - netExpenses - commissionsPaid);
        const vatNet      = r(totalVat - totalVatDeductible);

        return jsonCors(req, {
          year,
          revenue: {
            total_gross: r(totalGross),
            total_vat_collected: r(totalVat),
            total_net: netRevenue,
            by_month: Object.entries(revByMonth).map(([m, v]) => ({
              month: Number(m), gross: r(v.gross), vat: r(v.vat),
            })),
          },
          expenses: {
            total_gross: r(totalExpenses),
            total_vat_deductible: r(totalVatDeductible),
            total_net: netExpenses,
            count: (expenseResult.data ?? []).length,
            missing_invoice_count: missingInvoiceCount,
            by_month: Object.entries(expByMonth).map(([m, v]) => ({
              month: Number(m), total: r(v.total), count: v.count, missing_invoices: v.missing_invoices,
            })),
          },
          payroll: {
            commissions_paid: r(commissionsPaid),
            commissions_unpaid: r(commissionsUnpaid),
            staff_count: 0,
          },
          vat: { collected: r(totalVat), deductible: r(totalVatDeductible), net_payable: vatNet },
          profit: {
            gross: r(totalGross - totalExpenses - commissionsPaid),
            net: netProfit,
            margin_pct: totalGross > 0 ? r((netProfit / totalGross) * 100) : 0,
          },
        });
      }

      if (action === "bank-coverage") {
        const year = parseInt(url.searchParams.get("year") ?? "0", 10);
        if (!year) return badRequest("year is required");

        const { data: txRows, error: txErr } = await supabaseAdmin
          .from("bank_transactions")
          .select("date")
          .eq("business_id", businessId)
          .gte("date", `${year}-01-01`)
          .lt("date", `${year + 1}-01-01`)
          .order("date", { ascending: true });
        if (txErr) return serverError(txErr.message);

        const MONTHS = ["January","February","March","April","May","June",
          "July","August","September","October","November","December"];

        const monthData: Record<number, { count: number; import_date: string | null }> = {};
        for (let m = 1; m <= 12; m++) monthData[m] = { count: 0, import_date: null };

        for (const tx of txRows ?? []) {
          const m = new Date(tx.date as string).getMonth() + 1;
          monthData[m].count += 1;
          if (!monthData[m].import_date) monthData[m].import_date = tx.date as string;
        }

        const months = Object.entries(monthData).map(([m, v]) => ({
          month: Number(m),
          label: MONTHS[Number(m) - 1],
          has_statement: v.count > 0,
          transaction_count: v.count,
          import_date: v.import_date,
        }));

        return jsonCors(req, {
          year,
          months,
          covered_months: months.filter(m => m.has_statement).length,
          missing_months: months.filter(m => !m.has_statement).map(m => m.month),
        });
      }

      if (action === "payroll-summary") {
        const year = parseInt(url.searchParams.get("year") ?? "0", 10);
        if (!year) return badRequest("year is required");

        const yearStart = `${year}-01-01`;
        const yearEnd = `${year + 1}-01-01`;

        const { data: bizRow2 } = await supabaseAdmin
          .from("businesses").select("commission_rate").eq("id", businessId).maybeSingle();
        const bizRate2 = Number((bizRow2 as Record<string, unknown> | null)?.commission_rate ?? 0);

        const [paidResult, unpaidResult] = await Promise.all([
          supabaseAdmin
            .from("appointments")
            .select("staff_profile_id, commission_amount_paid, staff_profile:staff_profiles!staff_profile_id(display_name)")
            .eq("business_id", businessId)
            .eq("status", "completed")
            .not("commission_paid_at", "is", null)
            .gte("commission_paid_at", yearStart)
            .lt("commission_paid_at", yearEnd),
          supabaseAdmin
            .from("appointments")
            .select("staff_profile_id, price, staff_profile:staff_profiles!staff_profile_id(display_name), service:services(staff_commission_type, staff_commission_value)")
            .eq("business_id", businessId)
            .eq("status", "completed")
            .not("staff_profile_id", "is", null)
            .is("commission_paid_at", null)
            .is("deleted_at", null),
        ]);

        if (paidResult.error)   return serverError(paidResult.error.message);
        if (unpaidResult.error) return serverError(unpaidResult.error.message);

        const staffMap: Record<string, { display_name: string; paid: number; unpaid: number; appointment_count: number }> = {};

        for (const a of paidResult.data ?? []) {
          const id = a.staff_profile_id as string | null;
          if (!id) continue;
          const sp = (a as Record<string, unknown>).staff_profile as Record<string, unknown> | null;
          if (!staffMap[id]) staffMap[id] = { display_name: (sp?.display_name as string) ?? "Unknown", paid: 0, unpaid: 0, appointment_count: 0 };
          staffMap[id].paid += Number(a.commission_amount_paid ?? 0);
          staffMap[id].appointment_count += 1;
        }

        for (const a of unpaidResult.data ?? []) {
          const id = a.staff_profile_id as string | null;
          if (!id) continue;
          const sp = (a as Record<string, unknown>).staff_profile as Record<string, unknown> | null;
          const svc = (a as Record<string, unknown>).service as Record<string, unknown> | null;
          const price = Number(a.price ?? 0);
          const commType = (svc?.staff_commission_type as string) ?? "none";
          const commVal = Number(svc?.staff_commission_value ?? 0);
          let commAmt = 0;
          if (commType === "percentage") commAmt = (price * commVal) / 100;
          else if (commType === "fixed") commAmt = commVal;
          else commAmt = (price * bizRate2) / 100;
          if (!staffMap[id]) staffMap[id] = { display_name: (sp?.display_name as string) ?? "Unknown", paid: 0, unpaid: 0, appointment_count: 0 };
          staffMap[id].unpaid += Math.max(0, commAmt);
        }

        const r2 = (n: number) => Math.round(n * 100) / 100;
        const breakdown = Object.entries(staffMap).map(([id, v]) => ({
          staff_profile_id: id,
          display_name: v.display_name,
          paid: r2(v.paid),
          unpaid: r2(v.unpaid),
          appointment_count: v.appointment_count,
        }));

        return jsonCors(req, {
          year,
          commissions_paid: r2(breakdown.reduce((s, v) => s + v.paid, 0)),
          commissions_unpaid: r2(breakdown.reduce((s, v) => s + v.unpaid, 0)),
          staff_breakdown: breakdown,
        });
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
      return jsonCors(req, { ...expense, supplier: (expense as Record<string, unknown>).supplier ?? null }, 201);
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
      return jsonCors(req, { ...expense, supplier: (expense as Record<string, unknown>).supplier ?? null });
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
      return jsonCors(req, null, 204);
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("finance error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
