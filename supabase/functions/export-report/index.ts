import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { verifyAuth, requireOwnerOrManager } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReportType =
  | "accountant"
  | "income"
  | "expenses"
  | "tax_summary"
  | "staff_payroll"
  | "supplier_spend";

interface ExportBody {
  business_id: string;
  report_type: ReportType;
  date_range: { from: string; to: string };
  format: "csv";
}

const VALID_REPORT_TYPES: ReportType[] = [
  "accountant",
  "income",
  "expenses",
  "tax_summary",
  "staff_payroll",
  "supplier_spend",
];

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const headerLine = headers.map(escapeCsvValue).join(",");
  const dataLines = rows.map((row) =>
    headers.map((h) => escapeCsvValue(row[h])).join(","),
  );
  return [headerLine, ...dataLines].join("\r\n");
}

// ---------------------------------------------------------------------------
// Report generators
// ---------------------------------------------------------------------------

async function generateAccountantReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  // Income rows — payments with succeeded status
  const { data: payments, error: payErr } = await supabaseAdmin
    .from("payments")
    .select(`
      amount, tax_amount, paid_at, method,
      appointment:appointments!inner(
        booking_reference,
        service:services!inner(name)
      )
    `)
    .eq("business_id", businessId)
    .eq("status", "succeeded")
    .gte("paid_at", from)
    .lte("paid_at", to);

  if (payErr) throw payErr;

  // Expense rows
  const { data: expenses, error: expErr } = await supabaseAdmin
    .from("expenses")
    .select(`
      amount, tax_amount, date, description, category,
      supplier:suppliers(name)
    `)
    .eq("business_id", businessId)
    .gte("date", from)
    .lte("date", to);

  if (expErr) throw expErr;

  const incomeRows = (payments ?? []).map((p: any) => ({
    date: p.paid_at?.split("T")[0] ?? "",
    type: "Income",
    description: `Payment – ${p.appointment?.service?.name ?? "Service"}`,
    category: p.method ?? "card",
    amount: Number(p.amount),
    tax_amount: Number(p.tax_amount ?? 0),
    net_amount: Number(p.amount) - Number(p.tax_amount ?? 0),
    payment_method_or_supplier: p.method ?? "",
    reference: p.appointment?.booking_reference ?? "",
  }));

  const expenseRows = (expenses ?? []).map((e: any) => ({
    date: e.date ?? "",
    type: "Expense",
    description: e.description,
    category: e.category,
    amount: Number(e.amount),
    tax_amount: Number(e.tax_amount ?? 0),
    net_amount: Number(e.amount) - Number(e.tax_amount ?? 0),
    payment_method_or_supplier: e.supplier?.name ?? "",
    reference: "",
  }));

  const rows = [...incomeRows, ...expenseRows].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  return {
    headers: [
      "date",
      "type",
      "description",
      "category",
      "amount",
      "tax_amount",
      "net_amount",
      "payment_method_or_supplier",
      "reference",
    ],
    rows,
  };
}

async function generateIncomeReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const { data, error } = await supabaseAdmin
    .from("payments")
    .select(`
      amount, tax_amount, paid_at, method, tip_amount, discount_amount,
      appointment:appointments!inner(
        booking_reference, starts_at,
        service:services!inner(name),
        staff:staff_profiles(display_name),
        client:clients!inner(first_name, last_name)
      )
    `)
    .eq("business_id", businessId)
    .eq("status", "succeeded")
    .gte("paid_at", from)
    .lte("paid_at", to)
    .order("paid_at", { ascending: true });

  if (error) throw error;

  const rows = (data ?? []).map((p: any) => ({
    date: p.paid_at?.split("T")[0] ?? "",
    client_name: `${p.appointment?.client?.first_name ?? ""} ${p.appointment?.client?.last_name ?? ""}`.trim(),
    service: p.appointment?.service?.name ?? "",
    staff: p.appointment?.staff?.display_name ?? "",
    amount: Number(p.amount),
    tip: Number(p.tip_amount ?? 0),
    discount: Number(p.discount_amount ?? 0),
    tax: Number(p.tax_amount ?? 0),
    method: p.method ?? "",
    reference: p.appointment?.booking_reference ?? "",
  }));

  return {
    headers: ["date", "client_name", "service", "staff", "amount", "tip", "discount", "tax", "method", "reference"],
    rows,
  };
}

async function generateExpensesReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const { data, error } = await supabaseAdmin
    .from("expenses")
    .select(`
      date, category, description, amount, tax_amount, receipt_url,
      supplier:suppliers(name)
    `)
    .eq("business_id", businessId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });

  if (error) throw error;

  const rows = (data ?? []).map((e: any) => ({
    date: e.date ?? "",
    category: e.category,
    supplier_name: e.supplier?.name ?? "",
    description: e.description,
    amount: Number(e.amount),
    tax_amount: Number(e.tax_amount ?? 0),
    receipt_url: e.receipt_url ?? "",
  }));

  return {
    headers: ["date", "category", "supplier_name", "description", "amount", "tax_amount", "receipt_url"],
    rows,
  };
}

async function generateTaxSummaryReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const startYear = new Date(from).getFullYear();
  const endYear = new Date(to).getFullYear();

  const allRows: Record<string, unknown>[] = [];

  for (let year = startYear; year <= endYear; year++) {
    const { data, error } = await supabaseAdmin.rpc("get_tax_summary", {
      p_business_id: businessId,
      p_year: year,
      p_quarter: null,
    });

    if (error) throw error;
    if (!data) continue;

    const summary = data as {
      period_breakdown: {
        period: string;
        income: number;
        tax: number;
        expenses: number;
        profit: number;
      }[];
      gross_income: number;
      tax_collected: number;
      total_expenses: number;
      net_profit: number;
    };

    for (const pb of summary.period_breakdown ?? []) {
      // Estimated liability = tax collected (VAT collected on sales)
      allRows.push({
        period: pb.period,
        gross_income: Number(pb.income),
        tax_collected: Number(pb.tax),
        total_expenses: Number(pb.expenses),
        estimated_liability: Number(pb.tax),
      });
    }
  }

  return {
    headers: ["period", "gross_income", "tax_collected", "total_expenses", "estimated_liability"],
    rows: allRows,
  };
}

async function generateStaffPayrollReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const { data, error } = await supabaseAdmin.rpc("get_staff_performance", {
    p_business_id: businessId,
    p_start_date: from,
    p_end_date: to,
  });

  if (error) throw error;

  const rows = (data ?? []).map((s: any) => ({
    name: s.display_name ?? "",
    bookings: Number(s.bookings ?? 0),
    revenue: Number(s.revenue ?? 0),
    commission_rate: Number(s.completion_rate ?? 0),
    commission_amount: Number(s.commission_amount ?? 0),
  }));

  return {
    headers: ["name", "bookings", "revenue", "commission_rate", "commission_amount"],
    rows,
  };
}

async function generateSupplierSpendReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const { data, error } = await supabaseAdmin.rpc("get_supplier_spend", {
    p_business_id: businessId,
    p_start_date: from,
    p_end_date: to,
  });

  if (error) throw error;

  const rows = (data ?? []).map((s: any) => ({
    supplier_name: s.supplier_name ?? "",
    orders: Number(s.order_count ?? 0),
    total_spent: Number(s.total_spent ?? 0),
  }));

  return {
    headers: ["supplier_name", "orders", "total_spent"],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Report dispatcher
// ---------------------------------------------------------------------------

const GENERATORS: Record<
  ReportType,
  (businessId: string, from: string, to: string) => Promise<{ headers: string[]; rows: Record<string, unknown>[] }>
> = {
  accountant: generateAccountantReport,
  income: generateIncomeReport,
  expenses: generateExpensesReport,
  tax_summary: generateTaxSummaryReport,
  staff_payroll: generateStaffPayrollReport,
  supplier_spend: generateSupplierSpendReport,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("export-report", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  try {
    // ── Auth ──────────────────────────────────────────────────
    const user = await verifyAuth(req);

    const body: ExportBody = await req.json();

    // ── Validate ─────────────────────────────────────────────
    if (!body.business_id) return badRequest("business_id is required");
    if (!body.report_type || !VALID_REPORT_TYPES.includes(body.report_type)) {
      return badRequest(
        `report_type must be one of: ${VALID_REPORT_TYPES.join(", ")}`,
      );
    }
    if (!body.date_range?.from || !body.date_range?.to) {
      return badRequest("date_range.from and date_range.to are required");
    }

    // ── Authorize ────────────────────────────────────────────
    await requireOwnerOrManager(user.id, body.business_id);

    // ── Generate report ──────────────────────────────────────
    const generator = GENERATORS[body.report_type];
    const { headers, rows } = await generator(
      body.business_id,
      body.date_range.from,
      body.date_range.to,
    );

    const csv = toCsv(headers, rows);

    // ── Upload to Storage ────────────────────────────────────
    const timestamp = Date.now();
    const year = new Date(body.date_range.from).getFullYear();
    const filename = `${body.report_type}_${timestamp}.csv`;
    const storagePath = `reports/${body.business_id}/${year}/${filename}`;

    const { error: uploadErr } = await supabaseAdmin.storage
      .from("reports")
      .upload(storagePath, new TextEncoder().encode(csv), {
        contentType: "text/csv",
        upsert: false,
      });

    if (uploadErr) throw uploadErr;

    // ── Signed URL — 1 hour ──────────────────────────────────
    const { data: signedData, error: signErr } = await supabaseAdmin.storage
      .from("reports")
      .createSignedUrl(storagePath, 3600);

    if (signErr) throw signErr;

    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    return new Response(
      JSON.stringify({
        download_url: signedData.signedUrl,
        filename,
        expires_at: expiresAt,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    // Auth helpers throw Response objects directly
    if (err instanceof Response) return err;

    console.error("export-report error:", err);
    return serverError(
      err instanceof Error ? err.message : "Failed to generate report",
    );
  }
}));
