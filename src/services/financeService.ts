import { supabase } from "../lib/supabase";
import { NetworkError } from "../types/api";
import type {
  BookkeepingTransaction,
  CreateExpenseData,
  DateRange,
  ExpenseBreakdown,
  ExpenseFilters,
  ExpenseRow,
  IncomePeriod,
  PaginatedExpenses,
  RevenueSummary,
  StaffPerformanceRow,
  SupplierSpendRow,
  TaxSummary,
} from "../types/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) {
    headers["Authorization"] = `Bearer ${session.access_token}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Revenue summary
// ---------------------------------------------------------------------------

export async function getRevenueSummary(
  businessId: string,
  dateRange: DateRange,
): Promise<RevenueSummary> {
  const { data, error } = await supabase.rpc("get_revenue_summary", {
    p_business_id: businessId,
    p_start_date: dateRange.from,
    p_end_date: dateRange.to,
  });
  if (error) throw new NetworkError(error.message, 500);
  return data as RevenueSummary;
}

// ---------------------------------------------------------------------------
// Income breakdown (by day/week/month)
// ---------------------------------------------------------------------------

export async function getIncomeBreakdown(
  businessId: string,
  dateRange: DateRange,
  groupBy: "day" | "week" | "month" = "month",
): Promise<IncomePeriod[]> {
  const { data, error } = await supabase.rpc("get_income_breakdown", {
    p_business_id: businessId,
    p_start_date: dateRange.from,
    p_end_date: dateRange.to,
    p_group_by: groupBy,
  });
  if (error) throw new NetworkError(error.message, 500);
  return (data ?? []) as IncomePeriod[];
}

// ---------------------------------------------------------------------------
// Expenses — paginated list with filters + LEFT JOIN suppliers
// ---------------------------------------------------------------------------

export async function getExpenses(
  businessId: string,
  filters: ExpenseFilters = {},
): Promise<PaginatedExpenses> {
  const {
    category,
    supplierId,
    dateFrom,
    dateTo,
    search,
    page = 1,
    limit = 25,
  } = filters;

  let query = supabase
    .from("expenses")
    .select(
      `
      *,
      supplier:suppliers(id, name)
    `,
      { count: "exact" },
    )
    .eq("business_id", businessId)
    .order("date", { ascending: false });

  if (category) query = query.eq("category", category);
  if (supplierId) query = query.eq("supplier_id", supplierId);
  if (dateFrom) query = query.gte("date", dateFrom);
  if (dateTo) query = query.lte("date", dateTo);
  if (search) {
    query = query.ilike("description", `%${search}%`);
  }

  const from = (page - 1) * limit;
  query = query.range(from, from + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new NetworkError(error.message, 500);

  const expenses = (data ?? []).map((row: any) => ({
    ...row,
    supplier: row.supplier ?? null,
  })) as ExpenseRow[];

  return { expenses, total: count ?? 0 };
}

// ---------------------------------------------------------------------------
// Create expense  (optional receipt upload to Storage)
// ---------------------------------------------------------------------------

export async function createExpense(
  businessId: string,
  data: CreateExpenseData,
  receiptFile?: File,
): Promise<ExpenseRow> {
  let receiptUrl: string | null = null;

  if (receiptFile) {
    const fileId = crypto.randomUUID();
    const path = `receipts/${businessId}/expenses/${fileId}/${receiptFile.name}`;

    const { error: uploadErr } = await supabase.storage
      .from("receipts")
      .upload(path, receiptFile, {
        cacheControl: "3600",
        upsert: false,
      });
    if (uploadErr) throw new NetworkError(uploadErr.message, 500);

    const { data: urlData } = supabase.storage
      .from("receipts")
      .getPublicUrl(path);
    receiptUrl = urlData.publicUrl;
  }

  const { data: expense, error } = await supabase
    .from("expenses")
    .insert({
      business_id: businessId,
      supplier_id: data.supplier_id ?? null,
      category: data.category,
      description: data.description,
      amount: data.amount,
      currency_code: data.currency_code ?? "EUR",
      tax_amount: data.tax_amount ?? 0,
      tax_rate: data.tax_rate ?? 0,
      receipt_url: receiptUrl,
      date: data.date,
      is_recurring: data.is_recurring ?? false,
      recurrence_rule: data.recurrence_rule ?? null,
      recurrence_end_date: data.recurrence_end_date ?? null,
      notes: data.notes ?? null,
    })
    .select(
      `
      *,
      supplier:suppliers(id, name)
    `,
    )
    .single();

  if (error) throw new NetworkError(error.message, 500);
  return { ...expense, supplier: expense.supplier ?? null } as ExpenseRow;
}

// ---------------------------------------------------------------------------
// Update expense
// ---------------------------------------------------------------------------

export async function updateExpense(
  id: string,
  data: Partial<CreateExpenseData>,
): Promise<ExpenseRow> {
  const { data: expense, error } = await supabase
    .from("expenses")
    .update(data)
    .eq("id", id)
    .select(
      `
      *,
      supplier:suppliers(id, name)
    `,
    )
    .single();

  if (error) throw new NetworkError(error.message, 500);
  return { ...expense, supplier: expense.supplier ?? null } as ExpenseRow;
}

// ---------------------------------------------------------------------------
// Delete expense
// ---------------------------------------------------------------------------

export async function deleteExpense(id: string): Promise<void> {
  const { error } = await supabase.from("expenses").delete().eq("id", id);
  if (error) throw new NetworkError(error.message, 500);
}

// ---------------------------------------------------------------------------
// Expense breakdown (by category)
// ---------------------------------------------------------------------------

export async function getExpenseBreakdown(
  businessId: string,
  dateRange: DateRange,
): Promise<ExpenseBreakdown[]> {
  const { data, error } = await supabase.rpc("get_expense_breakdown", {
    p_business_id: businessId,
    p_start_date: dateRange.from,
    p_end_date: dateRange.to,
  });
  if (error) throw new NetworkError(error.message, 500);
  return (data ?? []) as ExpenseBreakdown[];
}

// ---------------------------------------------------------------------------
// Tax summary
// ---------------------------------------------------------------------------

export async function getTaxSummary(
  businessId: string,
  year: number,
  quarter?: number,
): Promise<TaxSummary> {
  const { data, error } = await supabase.rpc("get_tax_summary", {
    p_business_id: businessId,
    p_year: year,
    p_quarter: quarter ?? null,
  });
  if (error) throw new NetworkError(error.message, 500);
  return data as TaxSummary;
}

// ---------------------------------------------------------------------------
// Bookkeeping transactions — UNION of income + expenses with running balance
// ---------------------------------------------------------------------------

export async function getBookkeepingTransactions(
  businessId: string,
  dateRange: DateRange,
): Promise<BookkeepingTransaction[]> {
  // Fetch payments (income)
  const { data: payments, error: payErr } = await supabase
    .from("payments")
    .select(
      `
      id, amount, tax_amount, paid_at, method,
      appointment:appointments!inner(
        booking_reference,
        service:services!inner(name)
      )
    `,
    )
    .eq("business_id", businessId)
    .eq("status", "succeeded")
    .gte("paid_at", dateRange.from)
    .lte("paid_at", dateRange.to);

  if (payErr) throw new NetworkError(payErr.message, 500);

  // Fetch expenses
  const { data: expenses, error: expErr } = await supabase
    .from("expenses")
    .select("id, amount, tax_amount, date, description, category")
    .eq("business_id", businessId)
    .gte("date", dateRange.from)
    .lte("date", dateRange.to);

  if (expErr) throw new NetworkError(expErr.message, 500);

  // Merge into a single sorted list
  const incomeRows: Omit<BookkeepingTransaction, "running_balance">[] = (
    payments ?? []
  ).map((p: any) => ({
    date: p.paid_at,
    type: "income" as const,
    description: `Payment – ${p.appointment?.service?.name ?? "Service"} (${p.appointment?.booking_reference ?? ""})`,
    category: p.method ?? "card",
    amount: Number(p.amount),
    tax_amount: Number(p.tax_amount ?? 0),
  }));

  const expenseRows: Omit<BookkeepingTransaction, "running_balance">[] = (
    expenses ?? []
  ).map((e: any) => ({
    date: e.date,
    type: "expense" as const,
    description: e.description,
    category: e.category,
    amount: Number(e.amount),
    tax_amount: Number(e.tax_amount ?? 0),
  }));

  const merged = [...incomeRows, ...expenseRows].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  // Compute running balance
  let balance = 0;
  const transactions: BookkeepingTransaction[] = merged.map((row) => {
    balance += row.type === "income" ? row.amount : -row.amount;
    return { ...row, running_balance: Math.round(balance * 100) / 100 };
  });

  return transactions;
}

// ---------------------------------------------------------------------------
// Staff performance
// ---------------------------------------------------------------------------

export async function getStaffPerformance(
  businessId: string,
  dateRange: DateRange,
): Promise<StaffPerformanceRow[]> {
  const { data, error } = await supabase.rpc("get_staff_performance", {
    p_business_id: businessId,
    p_start_date: dateRange.from,
    p_end_date: dateRange.to,
  });
  if (error) throw new NetworkError(error.message, 500);
  return (data ?? []) as StaffPerformanceRow[];
}

// ---------------------------------------------------------------------------
// Supplier spend
// ---------------------------------------------------------------------------

export async function getSupplierSpend(
  businessId: string,
  dateRange: DateRange,
): Promise<SupplierSpendRow[]> {
  const { data, error } = await supabase.rpc("get_supplier_spend", {
    p_business_id: businessId,
    p_start_date: dateRange.from,
    p_end_date: dateRange.to,
  });
  if (error) throw new NetworkError(error.message, 500);
  return (data ?? []) as SupplierSpendRow[];
}

// ---------------------------------------------------------------------------
// Export report — calls export-report Edge Function, returns a download URL
// ---------------------------------------------------------------------------

export async function exportReport(
  businessId: string,
  reportType: string,
  dateRange: DateRange,
  format: "csv" | "json" = "csv",
): Promise<string> {
  const headers = await authHeaders();

  const res = await fetch(`${FUNCTIONS_URL}/export-report`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      business_id: businessId,
      report_type: reportType,
      start_date: dateRange.from,
      end_date: dateRange.to,
      format,
    }),
  });

  if (!res.ok) {
    let body;
    try {
      body = await res.json();
    } catch {
      // non-JSON
    }
    throw new NetworkError(
      body?.error?.message ?? res.statusText,
      res.status,
      body,
    );
  }

  const result = await res.json();
  return result.download_url as string;
}
