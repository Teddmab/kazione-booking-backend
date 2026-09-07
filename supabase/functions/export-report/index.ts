import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReportType =
  | "accountant"
  | "income"
  | "expenses"
  | "tax_summary"
  | "staff_payroll"
  | "supplier_spend"
  | "bank_transactions"
  | "cash_flow"
  | "inventory_movement";

type DirectReportType = "appointments" | "revenue" | "clients";

interface ExportBody {
  business_id: string;
  report_type: ReportType;
  date_range: { from: string; to: string };
  format: "csv" | "pdf";
}

const VALID_REPORT_TYPES: ReportType[] = [
  "accountant",
  "income",
  "expenses",
  "tax_summary",
  "staff_payroll",
  "supplier_spend",
  "bank_transactions",
  "cash_flow",
  "inventory_movement",
];

const REPORT_TITLES: Record<ReportType, string> = {
  accountant: "Accountant Export",
  income: "Income by Service",
  expenses: "Operating Costs by Category",
  tax_summary: "Profit & Loss",
  staff_payroll: "Staff Commission Summary",
  supplier_spend: "Supplier Spend",
  bank_transactions: "Bank Transactions",
  cash_flow: "Cash-Flow Statement",
  inventory_movement: "Product Cost & Inventory Movement",
};

const VALID_DIRECT_TYPES: DirectReportType[] = ["appointments", "revenue", "clients"];

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
// PDF helper — one shared fixed-width table renderer for every report type,
// rather than a bespoke layout per report. Good enough for the tabular
// headers/rows shape every generator already produces for CSV; not a
// general-purpose PDF layout engine.
// ---------------------------------------------------------------------------

async function renderPdf(title: string, headers: string[], rows: Record<string, unknown>[]): Promise<Uint8Array> {
  const PAGE_WIDTH = 595.28; // A4 portrait, points
  const PAGE_HEIGHT = 841.89;
  const MARGIN = 40;
  const ROW_HEIGHT = 16;

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const colWidth = (PAGE_WIDTH - MARGIN * 2) / Math.max(headers.length, 1);
  const maxChars = Math.max(6, Math.floor(colWidth / 5));

  let page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function truncate(text: string): string {
    return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
  }

  function drawTableHeader() {
    page.drawText(title, { x: MARGIN, y, size: 14, font: boldFont });
    y -= 18;
    page.drawText(`Generated ${new Date().toISOString().slice(0, 10)}`, {
      x: MARGIN, y, size: 8, font, color: rgb(0.45, 0.45, 0.45),
    });
    y -= 22;
    headers.forEach((h, i) => {
      page.drawText(truncate(String(h)), { x: MARGIN + i * colWidth, y, size: 9, font: boldFont });
    });
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y },
      thickness: 0.5, color: rgb(0.75, 0.75, 0.75),
    });
    y -= ROW_HEIGHT;
  }

  drawTableHeader();

  for (const row of rows) {
    if (y < MARGIN + ROW_HEIGHT) {
      page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
      drawTableHeader();
    }
    headers.forEach((h, i) => {
      const val = row[h];
      const text = val === null || val === undefined ? "" : String(val);
      page.drawText(truncate(text), { x: MARGIN + i * colWidth, y, size: 8, font });
    });
    y -= ROW_HEIGHT;
  }

  if (rows.length === 0) {
    page.drawText("No data for this period.", { x: MARGIN, y, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
  }

  return doc.save();
}

// ---------------------------------------------------------------------------
// Report generators
// ---------------------------------------------------------------------------

async function generateAccountantReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  // Income rows — paid payments
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
    .eq("status", "paid")
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

  // deno-lint-ignore no-explicit-any
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

  // deno-lint-ignore no-explicit-any
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
        staff:staff_profiles!staff_profile_id(display_name),
        client:clients!inner(first_name, last_name)
      )
    `)
    .eq("business_id", businessId)
    .eq("status", "paid")
    .gte("paid_at", from)
    .lte("paid_at", to)
    .order("paid_at", { ascending: true });

  if (error) throw error;

  // deno-lint-ignore no-explicit-any
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

  // deno-lint-ignore no-explicit-any
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

  // deno-lint-ignore no-explicit-any
  const rows = (data ?? []).map((s: any) => ({
    name: s.display_name ?? "",
    bookings: Number(s.bookings ?? 0),
    revenue: Number(s.revenue ?? 0),
    commission_amount: Number(s.commission_amount ?? 0),
    commission_paid: Number(s.paid_commission ?? 0),
    commission_unpaid: Number(s.unpaid_commission ?? 0),
  }));

  return {
    headers: ["name", "bookings", "revenue", "commission_amount", "commission_paid", "commission_unpaid"],
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

  // deno-lint-ignore no-explicit-any
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

async function generateBankTransactionsReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const { data, error } = await supabaseAdmin
    .from("bank_transactions")
    .select(`
      date, description, amount, currency_code, category, reference,
      reconciled_payment_id, reconciled_expense_id, reconciled_fixed_cost_id,
      reconciled_debt_payment_id, reconciled_appointment_id, reconciled_stock_movement_id
    `)
    .eq("business_id", businessId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });

  if (error) throw error;

  // deno-lint-ignore no-explicit-any
  const rows = (data ?? []).map((t: any) => ({
    date: t.date ?? "",
    description: t.description ?? "",
    amount: Number(t.amount),
    currency: t.currency_code ?? "EUR",
    category: t.category ?? "Uncategorized",
    reference: t.reference ?? "",
    reconciled: [
      t.reconciled_payment_id, t.reconciled_expense_id, t.reconciled_fixed_cost_id,
      t.reconciled_debt_payment_id, t.reconciled_appointment_id, t.reconciled_stock_movement_id,
    ].some((v) => v !== null) ? "yes" : "no",
  }));

  return {
    headers: ["date", "description", "amount", "currency", "category", "reference", "reconciled"],
    rows,
  };
}

async function generateCashFlowReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const { data, error } = await supabaseAdmin
    .from("bank_transactions")
    .select("date, amount")
    .eq("business_id", businessId)
    .gte("date", from)
    .lte("date", to)
    .order("date", { ascending: true });

  if (error) throw error;

  const byMonth: Record<string, { in: number; out: number }> = {};
  for (const t of data ?? []) {
    const row = t as { date: string; amount: unknown };
    const month = row.date.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = { in: 0, out: 0 };
    const amt = Number(row.amount ?? 0);
    if (amt > 0) byMonth[month].in += amt;
    else byMonth[month].out += Math.abs(amt);
  }

  const rows = Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, v]) => ({
      period: month,
      money_in: Math.round(v.in * 100) / 100,
      money_out: Math.round(v.out * 100) / 100,
      net_cash_flow: Math.round((v.in - v.out) * 100) / 100,
    }));

  return {
    headers: ["period", "money_in", "money_out", "net_cash_flow"],
    rows,
  };
}

async function generateInventoryMovementReport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const { data, error } = await supabaseAdmin
    .from("stock_movements")
    .select("movement_type, quantity, unit_cost, product:product_catalog(name, unit)")
    .eq("business_id", businessId)
    .gte("movement_date", from)
    .lte("movement_date", to);

  if (error) throw error;

  const IN_TYPES = new Set(["purchase", "manual_in"]);

  const byProduct: Record<string, { name: string; unit: string; qtyIn: number; qtyOut: number; cost: number }> = {};
  // deno-lint-ignore no-explicit-any
  for (const m of (data ?? []) as any[]) {
    const name = m.product?.name ?? "Unknown product";
    const key = name;
    if (!byProduct[key]) byProduct[key] = { name, unit: m.product?.unit ?? "unit", qtyIn: 0, qtyOut: 0, cost: 0 };
    const qty = Math.abs(Number(m.quantity ?? 0));
    if (IN_TYPES.has(m.movement_type)) {
      byProduct[key].qtyIn += qty;
      byProduct[key].cost += qty * Number(m.unit_cost ?? 0);
    } else {
      byProduct[key].qtyOut += qty;
    }
  }

  const rows = Object.values(byProduct)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({
      product: p.name,
      unit: p.unit,
      quantity_in: p.qtyIn,
      quantity_out: p.qtyOut,
      cost_of_goods: Math.round(p.cost * 100) / 100,
    }));

  return {
    headers: ["product", "unit", "quantity_in", "quantity_out", "cost_of_goods"],
    rows,
  };
}

// ---------------------------------------------------------------------------
// Direct download report generators (GET — no Storage upload)
// ---------------------------------------------------------------------------

async function generateAppointmentsExport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select(`
      id, status, starts_at, ends_at, price, notes, booking_reference,
      client:clients!inner(first_name, last_name, email, phone),
      service:services(name)
    `)
    .eq("business_id", businessId)
    .gte("starts_at", from)
    .lte("starts_at", to + "T23:59:59")
    .order("starts_at");

  if (error) throw error;

  // deno-lint-ignore no-explicit-any
  const rows = (data ?? []).map((a: any) => ({
    date: a.starts_at?.slice(0, 10) ?? "",
    time: a.starts_at?.slice(11, 16) ?? "",
    client_name: `${a.client?.first_name ?? ""} ${a.client?.last_name ?? ""}`.trim(),
    client_email: a.client?.email ?? "",
    client_phone: a.client?.phone ?? "",
    service: a.service?.name ?? "",
    status: a.status ?? "",
    price: a.price ?? "",
    notes: a.notes ?? "",
    booking_reference: a.booking_reference ?? "",
  }));

  return {
    headers: ["date", "time", "client_name", "client_email", "client_phone", "service", "status", "price", "notes", "booking_reference"],
    rows,
  };
}

async function generateRevenueExport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("starts_at, price")
    .eq("business_id", businessId)
    .eq("status", "completed")
    .gte("starts_at", from)
    .lte("starts_at", to + "T23:59:59")
    .order("starts_at");

  if (error) throw error;

  const grouped: Record<string, number> = {};
  for (const a of data ?? []) {
    const aRow = a as { starts_at?: string; price?: unknown };
    const date = aRow.starts_at?.slice(0, 10);
    if (date) grouped[date] = (grouped[date] ?? 0) + Number(aRow.price ?? 0);
  }

  const rows = Object.entries(grouped)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, revenue]) => ({ date, revenue }));

  return {
    headers: ["date", "revenue"],
    rows,
  };
}

async function generateClientsExport(
  businessId: string,
  from: string,
  to: string,
): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const [{ data: appts, error: apptErr }, { data: clients, error: clientErr }] = await Promise.all([
    supabaseAdmin
      .from("appointments")
      .select("client_id, starts_at, price")
      .eq("business_id", businessId)
      .gte("starts_at", from)
      .lte("starts_at", to + "T23:59:59"),
    supabaseAdmin
      .from("clients")
      .select("id, first_name, last_name, email, phone, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false }),
  ]);

  if (apptErr) throw apptErr;
  if (clientErr) throw clientErr;

  const stats: Record<string, { visits: number; spend: number; last_visit: string | null }> = {};
  for (const a of appts ?? []) {
    const appt = a as { client_id: string; starts_at?: string; price?: unknown };
    if (!appt.client_id) continue;
    if (!stats[appt.client_id]) stats[appt.client_id] = { visits: 0, spend: 0, last_visit: null };
    stats[appt.client_id].visits += 1;
    stats[appt.client_id].spend += Number(appt.price ?? 0);
    const d = appt.starts_at?.slice(0, 10);
    if (d && (!stats[appt.client_id].last_visit || d > stats[appt.client_id].last_visit!)) {
      stats[appt.client_id].last_visit = d;
    }
  }

  // deno-lint-ignore no-explicit-any
  const rows = (clients ?? []).map((c: any) => ({
    name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
    email: c.email ?? "",
    phone: c.phone ?? "",
    client_since: c.created_at?.slice(0, 10) ?? "",
    total_visits: stats[c.id]?.visits ?? 0,
    total_spend: stats[c.id]?.spend ?? 0,
    last_visit: stats[c.id]?.last_visit ?? "",
  }));

  return {
    headers: ["name", "email", "phone", "client_since", "total_visits", "total_spend", "last_visit"],
    rows,
  };
}

// ---------------------------------------------------------------------------
// GET handler — direct download (no Storage upload)
// ---------------------------------------------------------------------------

async function handleGet(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const type = url.searchParams.get("type") as DirectReportType | null;
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const format = url.searchParams.get("format") ?? "json";
    const businessId = url.searchParams.get("business_id");

    if (!type || !VALID_DIRECT_TYPES.includes(type)) {
      return badRequest(`type must be one of: ${VALID_DIRECT_TYPES.join(", ")}`);
    }
    if (!from || !to) {
      return badRequest("from and to (YYYY-MM-DD) are required");
    }

    const ctx = await requireOwnerOrManagerCtx(req, businessId ?? undefined);
    if (ctx instanceof Response) return ctx;

    let result: { headers: string[]; rows: Record<string, unknown>[] };

    if (type === "appointments") {
      result = await generateAppointmentsExport(ctx.businessId, from, to);
    } else if (type === "revenue") {
      result = await generateRevenueExport(ctx.businessId, from, to);
    } else {
      result = await generateClientsExport(ctx.businessId, from, to);
    }

    if (format === "csv") {
      const csv = toCsv(result.headers, result.rows);
      return new Response(csv, {
        status: 200,
        headers: {
          ...corsHeadersFor(req),
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${type}-${from}-${to}.csv"`,
        },
      });
    }

    return new Response(
      JSON.stringify({
        data: {
          rows: result.rows,
          meta: { type, from, to, count: result.rows.length },
        },
      }),
      { status: 200, headers: { ...corsHeadersFor(req), "Content-Type": "application/json" } },
    );
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("export-report GET error:", err);
    return serverError(err instanceof Error ? err.message : "Failed to generate report");
  }
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
  bank_transactions: generateBankTransactionsReport,
  cash_flow: generateCashFlowReport,
  inventory_movement: generateInventoryMovementReport,
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("export-report", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method === "GET") {
    return handleGet(req);
  }

  if (req.method !== "POST") {
    return badRequest("Only GET and POST are allowed");
  }

  try {
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

    // ── Auth: verify JWT + owner/manager membership in one call ──────────────
    // business_id is verified against the DB — not blindly trusted from body
    const ctx = await requireOwnerOrManagerCtx(req, body.business_id);
    if (ctx instanceof Response) return ctx;
    const { businessId } = ctx;

    // ── Generate report ──────────────────────────────────────
    const generator = GENERATORS[body.report_type];
    const { headers, rows } = await generator(
      businessId,
      body.date_range.from,
      body.date_range.to,
    );

    const format = body.format === "pdf" ? "pdf" : "csv";
    const fileBytes: Uint8Array | string = format === "pdf"
      ? await renderPdf(REPORT_TITLES[body.report_type], headers, rows)
      : toCsv(headers, rows);
    const contentType = format === "pdf" ? "application/pdf" : "text/csv";

    // ── Upload to Storage ────────────────────────────────────
    const timestamp = Date.now();
    const year = new Date(body.date_range.from).getFullYear();
    const filename = `${body.report_type}_${timestamp}.${format}`;
    const storagePath = `reports/${businessId}/${year}/${filename}`;

    const uploadBody = typeof fileBytes === "string" ? new TextEncoder().encode(fileBytes) : fileBytes;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from("reports")
      .upload(storagePath, uploadBody, {
        contentType,
        upsert: false,
      });

    if (uploadErr) throw uploadErr;

    // ── Signed URL — 1 hour ──────────────────────────────────
    const { data: signedData, error: signErr } = await supabaseAdmin.storage
      .from("reports")
      .createSignedUrl(storagePath, 3600);

    if (signErr) throw signErr;

    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    // Best-effort — a logging failure shouldn't fail a report the user
    // already successfully generated and can already download.
    const { error: historyErr } = await supabaseAdmin.from("report_history").insert({
      business_id: businessId,
      report_type: body.report_type,
      period_from: body.date_range.from,
      period_to: body.date_range.to,
      format,
      file_path: storagePath,
      generated_by: ctx.userId,
    });
    if (historyErr) console.error("report_history insert failed:", historyErr.message);

    return new Response(
      JSON.stringify({
        download_url: signedData.signedUrl,
        filename,
        expires_at: expiresAt,
      }),
      {
        status: 200,
        headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
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
