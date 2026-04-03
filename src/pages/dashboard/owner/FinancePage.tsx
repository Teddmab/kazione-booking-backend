import { useState, useMemo, useCallback } from "react";
import { useAuth, useTenant } from "../../../hooks/useAuth";
import EmptyState from "../../../components/EmptyState";
import {
  useDateRange,
  useRevenueSummary,
  useIncomeBreakdown,
  useExpenses,
  useCreateExpense,
  useUpdateExpense,
  useDeleteExpense,
  useExpenseBreakdown,
  useTaxSummary,
  useBookkeepingTransactions,
  useExportReport,
  DATE_RANGE_PRESETS,
} from "../../../hooks/useFinance";
import type { DateRangePreset } from "../../../hooks/useFinance";
import { formatAmount } from "../../../lib/stripe";
import type {
  CreateExpenseData,
  DateRange,
  ExpenseCategory,
  ExpenseFilters,
  ExpenseRow,
} from "../../../types/api";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: "supplies", label: "Supplies" },
  { value: "rent", label: "Rent" },
  { value: "utilities", label: "Utilities" },
  { value: "payroll", label: "Payroll" },
  { value: "marketing", label: "Marketing" },
  { value: "equipment", label: "Equipment" },
  { value: "software", label: "Software" },
  { value: "professional_services", label: "Professional Services" },
  { value: "other", label: "Other" },
];

// ---------------------------------------------------------------------------
// Tab enum
// ---------------------------------------------------------------------------

const TABS = [
  "overview",
  "income",
  "expenses",
  "profitability",
  "bookkeeping",
  "tax",
  "annual",
  "export",
  "country_tax",
  "ai_assistant",
] as const;
type TabId = (typeof TABS)[number];

const TAB_LABELS: Record<TabId, string> = {
  overview: "Overview",
  income: "Income Tracking",
  expenses: "Expenses",
  profitability: "Profitability",
  bookkeeping: "Bookkeeping",
  tax: "Tax Compliance",
  annual: "Annual Reporting",
  export: "Accountant Export",
  country_tax: "Country Tax Config",
  ai_assistant: "AI Assistant",
};

// ---------------------------------------------------------------------------
// DateRangePicker (shared across tabs)
// ---------------------------------------------------------------------------

function DateRangePicker({
  preset,
  dateRange,
  selectPreset,
  setCustom,
}: {
  preset: DateRangePreset;
  dateRange: DateRange;
  selectPreset: (p: DateRangePreset) => void;
  setCustom: (r: DateRange) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {DATE_RANGE_PRESETS.map(([key, label]) => (
        <button
          key={key}
          onClick={() => selectPreset(key)}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            preset === key
              ? "bg-primary text-primary-foreground"
              : "bg-muted hover:bg-muted/80"
          }`}
        >
          {label}
        </button>
      ))}
      {preset === "custom" && (
        <div className="flex items-center gap-1">
          <input
            type="date"
            value={dateRange.from}
            onChange={(e) => setCustom({ ...dateRange, from: e.target.value })}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          />
          <span className="text-muted-foreground">–</span>
          <input
            type="date"
            value={dateRange.to}
            onChange={(e) => setCustom({ ...dateRange, to: e.target.value })}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: Finance Overview
// ---------------------------------------------------------------------------

function FinanceOverview({
  businessId,
  dateRange,
}: {
  businessId: string;
  dateRange: DateRange;
}) {
  const { data: summary, isLoading } = useRevenueSummary(businessId, dateRange);

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4">
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-lg bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Income" value={formatAmount(summary.total_income, "EUR")} />
        <StatCard label="Total Expenses" value={formatAmount(summary.total_expenses, "EUR")} />
        <StatCard
          label="Net Profit"
          value={formatAmount(summary.net_profit, "EUR")}
          sub={
            summary.total_income > 0
              ? `${((summary.net_profit / summary.total_income) * 100).toFixed(1)}% margin`
              : undefined
          }
        />
      </div>

      {/* Income by service */}
      <div>
        <h3 className="mb-2 text-sm font-medium">Income by Service</h3>
        <div className="space-y-1">
          {summary.income_by_service.map((s) => (
            <div key={s.service_id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
              <span>{s.service_name}</span>
              <span className="font-mono">{formatAmount(s.total, "EUR")} ({s.count})</span>
            </div>
          ))}
          {summary.income_by_service.length === 0 && (
            <p className="text-sm text-muted-foreground">No income data for this period.</p>
          )}
        </div>
      </div>

      {/* Income by staff */}
      <div>
        <h3 className="mb-2 text-sm font-medium">Income by Staff</h3>
        <div className="space-y-1">
          {summary.income_by_staff.map((s) => (
            <div key={s.staff_profile_id} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
              <span>{s.display_name}</span>
              <span className="font-mono">{formatAmount(s.total, "EUR")} ({s.count})</span>
            </div>
          ))}
        </div>
      </div>

      {/* Income by payment method */}
      <div>
        <h3 className="mb-2 text-sm font-medium">Payment Methods</h3>
        <div className="space-y-1">
          {summary.income_by_payment_method.map((m) => (
            <div key={m.method} className="flex items-center justify-between rounded border px-3 py-2 text-sm">
              <span className="capitalize">{m.method}</span>
              <span className="font-mono">{formatAmount(m.total, "EUR")} ({m.count})</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Income Tracking (chart)
// ---------------------------------------------------------------------------

function IncomeTracking({
  businessId,
  dateRange,
}: {
  businessId: string;
  dateRange: DateRange;
}) {
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month">("week");
  const { data: periods, isLoading } = useIncomeBreakdown(businessId, dateRange, groupBy);

  const maxAmount = useMemo(
    () => Math.max(...(periods ?? []).map((p) => p.amount), 1),
    [periods],
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-1 rounded-md border p-0.5 w-fit">
        {(["day", "week", "month"] as const).map((g) => (
          <button
            key={g}
            onClick={() => setGroupBy(g)}
            className={`rounded px-3 py-1 text-xs font-medium capitalize ${
              groupBy === g ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            }`}
          >
            {g}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="h-64 animate-pulse rounded bg-muted" />
      ) : (
        <div className="space-y-1">
          {(periods ?? []).map((p) => (
            <div key={p.period} className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">{p.period}</span>
              <div className="flex-1">
                <div
                  className="h-6 rounded bg-primary/20"
                  style={{ width: `${(p.amount / maxAmount) * 100}%` }}
                >
                  <div className="px-2 py-1 text-xs font-medium leading-none">
                    {formatAmount(p.amount, "EUR")}
                  </div>
                </div>
              </div>
              <span className="w-12 text-right text-xs text-muted-foreground">
                {p.appointment_count}
              </span>
            </div>
          ))}
          {(periods ?? []).length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No income data.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: Expenses Tracking
// ---------------------------------------------------------------------------

function NewExpenseForm({
  businessId,
  onClose,
}: {
  businessId: string;
  onClose: () => void;
}) {
  const createMutation = useCreateExpense(businessId);
  const [form, setForm] = useState<Partial<CreateExpenseData>>({
    category: "other",
    date: new Date().toISOString().split("T")[0],
  });
  const [receiptFile, setReceiptFile] = useState<File | undefined>();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createMutation.mutate(
      { data: form as CreateExpenseData, receiptFile },
      { onSuccess: onClose },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Add Expense</h4>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          ✕
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium">Category</label>
          <select
            value={form.category ?? "other"}
            onChange={(e) => setForm({ ...form, category: e.target.value as ExpenseCategory })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs font-medium">Date</label>
          <input
            type="date"
            required
            value={form.date ?? ""}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium">Description</label>
        <input
          type="text"
          required
          value={form.description ?? ""}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm"
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs font-medium">Amount</label>
          <input
            type="number"
            required
            min={0}
            step={0.01}
            value={form.amount ?? ""}
            onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-medium">Tax amount</label>
          <input
            type="number"
            min={0}
            step={0.01}
            value={form.tax_amount ?? ""}
            onChange={(e) => setForm({ ...form, tax_amount: Number(e.target.value) })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-medium">Tax rate %</label>
          <input
            type="number"
            min={0}
            step={0.01}
            value={form.tax_rate ?? ""}
            onChange={(e) => setForm({ ...form, tax_rate: Number(e.target.value) })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
      </div>
      <div>
        <label className="text-xs font-medium">Receipt (optional)</label>
        <input
          type="file"
          accept="image/*,.pdf"
          onChange={(e) => setReceiptFile(e.target.files?.[0])}
          className="mt-1 block w-full text-sm"
        />
      </div>
      <div>
        <label className="text-xs font-medium">Notes</label>
        <textarea
          value={form.notes ?? ""}
          onChange={(e) => setForm({ ...form, notes: e.target.value || null })}
          rows={2}
          className="mt-1 block w-full rounded-md border bg-background px-3 py-1.5 text-sm"
        />
      </div>
      {createMutation.error && (
        <p className="text-xs text-destructive">{createMutation.error.message}</p>
      )}
      <button
        type="submit"
        disabled={createMutation.isPending}
        className="w-full rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {createMutation.isPending ? "Saving…" : "Add Expense"}
      </button>
    </form>
  );
}

function ExpensesTracking({
  businessId,
  dateRange,
}: {
  businessId: string;
  dateRange: DateRange;
}) {
  const [showForm, setShowForm] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<ExpenseCategory | undefined>();
  const [page, setPage] = useState(1);

  const filters: ExpenseFilters = useMemo(
    () => ({
      category: categoryFilter,
      dateFrom: dateRange.from,
      dateTo: dateRange.to,
      page,
      limit: 25,
    }),
    [categoryFilter, dateRange, page],
  );

  const { data: expenseData, isLoading } = useExpenses(businessId, filters);
  const { data: breakdown } = useExpenseBreakdown(businessId, dateRange);
  const deleteMutation = useDeleteExpense();

  function handleDelete(id: string) {
    if (!confirm("Delete this expense?")) return;
    deleteMutation.mutate(id);
  }

  return (
    <div className="space-y-4">
      {/* Breakdown chart */}
      {breakdown && breakdown.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Breakdown by Category</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {breakdown.map((b) => (
              <div key={b.category} className="rounded border p-3 text-sm">
                <p className="capitalize font-medium">{b.category.replace("_", " ")}</p>
                <p className="text-lg font-bold">{formatAmount(b.amount, "EUR")}</p>
                <p className="text-xs text-muted-foreground">{b.expense_count} expenses</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <select
          value={categoryFilter ?? ""}
          onChange={(e) => {
            setCategoryFilter((e.target.value || undefined) as ExpenseCategory | undefined);
            setPage(1);
          }}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
        >
          <option value="">All categories</option>
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
        <button
          onClick={() => setShowForm(true)}
          className="ml-auto rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + Add Expense
        </button>
      </div>

      {showForm && <NewExpenseForm businessId={businessId} onClose={() => setShowForm(false)} />}

      {/* Expense list */}
      {isLoading ? (
        <div className="animate-pulse space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-12 rounded bg-muted" />
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {(expenseData?.expenses ?? []).map((exp) => (
            <div
              key={exp.id}
              className="flex items-center gap-3 rounded border p-3 text-sm"
            >
              <div className="flex-1">
                <p className="font-medium">{exp.description}</p>
                <p className="text-xs text-muted-foreground">
                  {exp.date} · <span className="capitalize">{exp.category.replace("_", " ")}</span>
                  {exp.supplier ? ` · ${exp.supplier.name}` : ""}
                </p>
              </div>
              <span className="font-mono font-medium">{formatAmount(exp.amount, "EUR")}</span>
              {exp.receipt_url && (
                <a
                  href={exp.receipt_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  Receipt
                </a>
              )}
              <button
                onClick={() => handleDelete(exp.id)}
                disabled={deleteMutation.isPending}
                className="text-xs text-destructive hover:underline disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          ))}
          {(expenseData?.expenses ?? []).length === 0 && (
            <EmptyState
              icon="💸"
              title="No expenses found"
              description="No expenses match your filters. Record your first expense to start tracking spending."
            />
          )}
        </div>
      )}

      {/* Pagination */}
      {expenseData && expenseData.total > 25 && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground">{expenseData.total} total</p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="rounded border px-3 py-1 hover:bg-muted disabled:opacity-50"
            >
              Previous
            </button>
            <span className="px-2 py-1">Page {page}</span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page * 25 >= expenseData.total}
              className="rounded border px-3 py-1 hover:bg-muted disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 4: Profitability
// ---------------------------------------------------------------------------

function ProfitabilityView({
  businessId,
  dateRange,
}: {
  businessId: string;
  dateRange: DateRange;
}) {
  const { data: summary, isLoading } = useRevenueSummary(businessId, dateRange);

  if (isLoading) {
    return <div className="h-48 animate-pulse rounded bg-muted" />;
  }
  if (!summary) return null;

  const margin = summary.total_income > 0
    ? ((summary.net_profit / summary.total_income) * 100).toFixed(1)
    : "0.0";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <StatCard label="Revenue" value={formatAmount(summary.total_income, "EUR")} />
        <StatCard label="Expenses" value={formatAmount(summary.total_expenses, "EUR")} />
        <StatCard label="Net Profit" value={formatAmount(summary.net_profit, "EUR")} />
        <StatCard label="Profit Margin" value={`${margin}%`} />
      </div>

      {/* Simple bar comparison */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Revenue vs Expenses</h3>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="w-20 text-xs text-muted-foreground">Revenue</span>
            <div className="flex-1 rounded bg-green-100 dark:bg-green-900">
              <div
                className="h-6 rounded bg-green-500"
                style={{
                  width: `${(summary.total_income / Math.max(summary.total_income, summary.total_expenses, 1)) * 100}%`,
                }}
              />
            </div>
            <span className="w-24 text-right text-xs font-mono">{formatAmount(summary.total_income, "EUR")}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-20 text-xs text-muted-foreground">Expenses</span>
            <div className="flex-1 rounded bg-red-100 dark:bg-red-900">
              <div
                className="h-6 rounded bg-red-500"
                style={{
                  width: `${(summary.total_expenses / Math.max(summary.total_income, summary.total_expenses, 1)) * 100}%`,
                }}
              />
            </div>
            <span className="w-24 text-right text-xs font-mono">{formatAmount(summary.total_expenses, "EUR")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 5: Bookkeeping Prep
// ---------------------------------------------------------------------------

function BookkeepingPrep({
  businessId,
  dateRange,
}: {
  businessId: string;
  dateRange: DateRange;
}) {
  const { data: transactions, isLoading } = useBookkeepingTransactions(businessId, dateRange);

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-10 rounded bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left">
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 text-right font-medium">Tax</th>
              <th className="px-3 py-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {(transactions ?? []).map((tx, i) => (
              <tr key={i} className="border-b hover:bg-muted/50">
                <td className="px-3 py-2 text-muted-foreground">{tx.date?.split("T")[0]}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      tx.type === "income"
                        ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                        : "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                    }`}
                  >
                    {tx.type === "income" ? "Income" : "Expense"}
                  </span>
                </td>
                <td className="px-3 py-2 max-w-xs truncate">{tx.description}</td>
                <td className="px-3 py-2 capitalize text-muted-foreground">{tx.category}</td>
                <td className={`px-3 py-2 text-right font-mono ${tx.type === "income" ? "text-green-600" : "text-red-600"}`}>
                  {tx.type === "income" ? "+" : "−"}{formatAmount(tx.amount, "EUR")}
                </td>
                <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                  {formatAmount(tx.tax_amount, "EUR")}
                </td>
                <td className="px-3 py-2 text-right font-mono font-medium">
                  {formatAmount(tx.running_balance, "EUR")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(transactions ?? []).length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">No transactions in this period.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 6: Tax Compliance
// ---------------------------------------------------------------------------

function TaxCompliance({ businessId }: { businessId: string }) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [quarter, setQuarter] = useState<number | undefined>();

  const { data: summary, isLoading } = useTaxSummary(businessId, year, quarter);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
        >
          {[currentYear, currentYear - 1, currentYear - 2].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <select
          value={quarter ?? ""}
          onChange={(e) => setQuarter(e.target.value ? Number(e.target.value) : undefined)}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
        >
          <option value="">Full year</option>
          <option value="1">Q1</option>
          <option value="2">Q2</option>
          <option value="3">Q3</option>
          <option value="4">Q4</option>
        </select>
      </div>

      {isLoading ? (
        <div className="animate-pulse space-y-3">
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => <div key={i} className="h-24 rounded bg-muted" />)}
          </div>
        </div>
      ) : summary ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Gross Income" value={formatAmount(summary.gross_income, "EUR")} />
            <StatCard label="Tax Collected" value={formatAmount(summary.tax_collected, "EUR")} />
            <StatCard label="Total Expenses" value={formatAmount(summary.total_expenses, "EUR")} />
            <StatCard label="Net Profit" value={formatAmount(summary.net_profit, "EUR")} />
          </div>

          {summary.period_breakdown.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium">Period Breakdown</h3>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="px-3 py-2 font-medium">Period</th>
                    <th className="px-3 py-2 text-right font-medium">Income</th>
                    <th className="px-3 py-2 text-right font-medium">Tax</th>
                    <th className="px-3 py-2 text-right font-medium">Expenses</th>
                    <th className="px-3 py-2 text-right font-medium">Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.period_breakdown.map((pb) => (
                    <tr key={pb.period} className="border-b hover:bg-muted/50">
                      <td className="px-3 py-2">{pb.period}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatAmount(pb.income, "EUR")}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatAmount(pb.tax, "EUR")}</td>
                      <td className="px-3 py-2 text-right font-mono">{formatAmount(pb.expenses, "EUR")}</td>
                      <td className="px-3 py-2 text-right font-mono font-medium">{formatAmount(pb.profit, "EUR")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 7: Annual Reporting
// ---------------------------------------------------------------------------

function AnnualReporting({ businessId }: { businessId: string }) {
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const { data: summary, isLoading } = useTaxSummary(businessId, year);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-medium">Annual Report</h3>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
        >
          {[currentYear, currentYear - 1, currentYear - 2, currentYear - 3].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="h-48 animate-pulse rounded bg-muted" />
      ) : summary ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Gross Income" value={formatAmount(summary.gross_income, "EUR")} />
            <StatCard label="Tax Collected" value={formatAmount(summary.tax_collected, "EUR")} />
            <StatCard label="Total Expenses" value={formatAmount(summary.total_expenses, "EUR")} />
            <StatCard label="Net Profit" value={formatAmount(summary.net_profit, "EUR")} />
          </div>

          {summary.period_breakdown.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium">Quarterly Breakdown</h3>
              <div className="space-y-1">
                {summary.period_breakdown.map((pb) => {
                  const maxVal = Math.max(
                    ...summary.period_breakdown.map((x) => x.income),
                    1,
                  );
                  return (
                    <div key={pb.period} className="flex items-center gap-3 text-sm">
                      <span className="w-20 shrink-0 text-xs text-muted-foreground">{pb.period}</span>
                      <div className="flex-1">
                        <div
                          className="h-6 rounded bg-primary/20"
                          style={{ width: `${(pb.income / maxVal) * 100}%` }}
                        >
                          <div className="px-2 py-1 text-xs font-medium leading-none">
                            {formatAmount(pb.income, "EUR")}
                          </div>
                        </div>
                      </div>
                      <span className="w-24 text-right text-xs font-mono">
                        Profit: {formatAmount(pb.profit, "EUR")}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 8: Accountant Export
// ---------------------------------------------------------------------------

function AccountantExport({
  businessId,
  dateRange,
}: {
  businessId: string;
  dateRange: DateRange;
}) {
  const exportMutation = useExportReport(businessId);

  const REPORT_TYPES = [
    { type: "accountant", label: "Full Transaction Report", desc: "Complete income + expense ledger for your accountant" },
    { type: "income", label: "Income Report", desc: "All payments with client, service, and staff details" },
    { type: "expenses", label: "Expense Report", desc: "All expenses with categories and receipts" },
    { type: "tax_summary", label: "Tax Summary", desc: "Quarterly tax breakdown with liabilities" },
    { type: "staff_payroll", label: "Staff Payroll", desc: "Staff bookings, revenue, and commissions" },
    { type: "supplier_spend", label: "Supplier Spend", desc: "Supplier order totals" },
  ];

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Export reports for the selected date range ({dateRange.from} – {dateRange.to}).
        Files will download as CSV.
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {REPORT_TYPES.map((r) => (
          <div key={r.type} className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="text-sm font-medium">{r.label}</p>
              <p className="text-xs text-muted-foreground">{r.desc}</p>
            </div>
            <button
              onClick={() =>
                exportMutation.mutate({
                  reportType: r.type,
                  dateRange,
                  format: "csv",
                })
              }
              disabled={exportMutation.isPending}
              className="shrink-0 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {exportMutation.isPending ? "Exporting…" : "Export CSV"}
            </button>
          </div>
        ))}
      </div>

      {exportMutation.error && (
        <p className="text-sm text-destructive">{exportMutation.error.message}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 9: Country Tax Config (placeholder — read/write business_settings)
// ---------------------------------------------------------------------------

function CountryTaxConfig({ businessId }: { businessId: string }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/50 p-6 text-center">
        <p className="text-sm font-medium">Country Tax Configuration</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Configure VAT rates, tax identification numbers, and country-specific
          reporting rules. This feature will integrate with your business settings.
        </p>
        <p className="mt-4 text-xs text-muted-foreground italic">
          Coming soon — will read/write business_settings table.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 10: AI Finance Assistant (Phase 5 placeholder)
// ---------------------------------------------------------------------------

function AIFinanceAssistant({ businessId }: { businessId: string }) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/50 p-6 text-center">
        <p className="text-sm font-medium">AI Finance Assistant</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Ask natural-language questions about your finances, get spending insights,
          forecast revenue, and receive tax optimization suggestions.
        </p>
        <p className="mt-4 text-xs text-muted-foreground italic">
          Phase 5 — powered by the ai-finance Edge Function.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main FinancePage
// ---------------------------------------------------------------------------

export default function FinancePage() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId ?? "";

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const { dateRange, preset, selectPreset, setCustom } = useDateRange("last30d");

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ────────────────────────────────────────────── */}
      <div className="space-y-3 border-b p-4">
        <h1 className="text-xl font-bold">Finance</h1>
        <DateRangePicker
          preset={preset}
          dateRange={dateRange}
          selectPreset={selectPreset}
          setCustom={setCustom}
        />
      </div>

      {/* ── Tab bar ───────────────────────────────────────────── */}
      <div className="overflow-x-auto border-b">
        <div className="flex min-w-max">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === tab
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>
      </div>

      {/* ── Tab content ───────────────────────────────────────── */}
      <div className="flex-1 overflow-auto p-4">
        {activeTab === "overview" && (
          <FinanceOverview businessId={businessId} dateRange={dateRange} />
        )}
        {activeTab === "income" && (
          <IncomeTracking businessId={businessId} dateRange={dateRange} />
        )}
        {activeTab === "expenses" && (
          <ExpensesTracking businessId={businessId} dateRange={dateRange} />
        )}
        {activeTab === "profitability" && (
          <ProfitabilityView businessId={businessId} dateRange={dateRange} />
        )}
        {activeTab === "bookkeeping" && (
          <BookkeepingPrep businessId={businessId} dateRange={dateRange} />
        )}
        {activeTab === "tax" && (
          <TaxCompliance businessId={businessId} />
        )}
        {activeTab === "annual" && (
          <AnnualReporting businessId={businessId} />
        )}
        {activeTab === "export" && (
          <AccountantExport businessId={businessId} dateRange={dateRange} />
        )}
        {activeTab === "country_tax" && (
          <CountryTaxConfig businessId={businessId} />
        )}
        {activeTab === "ai_assistant" && (
          <AIFinanceAssistant businessId={businessId} />
        )}
      </div>
    </div>
  );
}
