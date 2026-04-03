import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getRevenueSummary,
  getIncomeBreakdown,
  getExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseBreakdown,
  getTaxSummary,
  getBookkeepingTransactions,
  getStaffPerformance,
  getSupplierSpend,
  exportReport,
} from "../services/financeService";
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
// Date range presets
// ---------------------------------------------------------------------------

export type DateRangePreset =
  | "today"
  | "last7d"
  | "last30d"
  | "last90d"
  | "thisMonth"
  | "thisQuarter"
  | "thisYear"
  | "custom";

function computePresetRange(preset: DateRangePreset): DateRange {
  const now = new Date();
  const fmt = (d: Date) => d.toISOString().split("T")[0];
  const today = fmt(now);

  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "last7d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 6);
      return { from: fmt(d), to: today };
    }
    case "last30d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      return { from: fmt(d), to: today };
    }
    case "last90d": {
      const d = new Date(now);
      d.setDate(d.getDate() - 89);
      return { from: fmt(d), to: today };
    }
    case "thisMonth": {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { from: fmt(first), to: today };
    }
    case "thisQuarter": {
      const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      return { from: fmt(qStart), to: today };
    }
    case "thisYear": {
      const jan1 = new Date(now.getFullYear(), 0, 1);
      return { from: fmt(jan1), to: today };
    }
    case "custom":
      return { from: today, to: today };
  }
}

const PRESET_LABELS: Record<DateRangePreset, string> = {
  today: "Today",
  last7d: "Last 7 days",
  last30d: "Last 30 days",
  last90d: "Last 90 days",
  thisMonth: "This month",
  thisQuarter: "This quarter",
  thisYear: "This year",
  custom: "Custom",
};

export const DATE_RANGE_PRESETS = Object.entries(PRESET_LABELS) as [DateRangePreset, string][];

export function useDateRange(initial: DateRangePreset = "last30d") {
  const [preset, setPreset] = useState<DateRangePreset>(initial);
  const [customRange, setCustomRange] = useState<DateRange>(() =>
    computePresetRange("last30d"),
  );

  const dateRange: DateRange = useMemo(
    () => (preset === "custom" ? customRange : computePresetRange(preset)),
    [preset, customRange],
  );

  const selectPreset = useCallback(
    (p: DateRangePreset) => {
      setPreset(p);
      if (p !== "custom") setCustomRange(computePresetRange(p));
    },
    [],
  );

  const setCustom = useCallback((range: DateRange) => {
    setPreset("custom");
    setCustomRange(range);
  }, []);

  return { dateRange, preset, selectPreset, setCustom, presetLabels: PRESET_LABELS };
}

export function useRevenueSummary(businessId: string, dateRange: DateRange) {
  return useQuery<RevenueSummary>({
    queryKey: ["revenue-summary", businessId, dateRange],
    queryFn: () => getRevenueSummary(businessId, dateRange),
    enabled: !!businessId && !!dateRange.from && !!dateRange.to,
    staleTime: 300_000,
  });
}

export function useIncomeBreakdown(
  businessId: string,
  dateRange: DateRange,
  groupBy: "day" | "week" | "month" = "month",
) {
  return useQuery<IncomePeriod[]>({
    queryKey: ["income-breakdown", businessId, dateRange, groupBy],
    queryFn: () => getIncomeBreakdown(businessId, dateRange, groupBy),
    enabled: !!businessId && !!dateRange.from && !!dateRange.to,
  });
}

export function useExpenses(businessId: string, filters: ExpenseFilters = {}) {
  return useQuery<PaginatedExpenses>({
    queryKey: ["expenses", businessId, filters],
    queryFn: () => getExpenses(businessId, filters),
    enabled: !!businessId,
  });
}

export function useCreateExpense(businessId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    ExpenseRow,
    Error,
    { data: CreateExpenseData; receiptFile?: File }
  >({
    mutationFn: ({ data, receiptFile }) =>
      createExpense(businessId, data, receiptFile),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["expense-breakdown"] });
      queryClient.invalidateQueries({ queryKey: ["revenue-summary"] });
      queryClient.invalidateQueries({ queryKey: ["bookkeeping"] });
    },
  });
}

export function useUpdateExpense() {
  const queryClient = useQueryClient();
  return useMutation<
    ExpenseRow,
    Error,
    { id: string; data: Partial<CreateExpenseData> }
  >({
    mutationFn: ({ id, data }) => updateExpense(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["expense-breakdown"] });
      queryClient.invalidateQueries({ queryKey: ["revenue-summary"] });
      queryClient.invalidateQueries({ queryKey: ["bookkeeping"] });
    },
  });
}

export function useDeleteExpense() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => deleteExpense(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expenses"] });
      queryClient.invalidateQueries({ queryKey: ["expense-breakdown"] });
      queryClient.invalidateQueries({ queryKey: ["revenue-summary"] });
      queryClient.invalidateQueries({ queryKey: ["bookkeeping"] });
    },
  });
}

export function useExpenseBreakdown(businessId: string, dateRange: DateRange) {
  return useQuery<ExpenseBreakdown[]>({
    queryKey: ["expense-breakdown", businessId, dateRange],
    queryFn: () => getExpenseBreakdown(businessId, dateRange),
    enabled: !!businessId && !!dateRange.from && !!dateRange.to,
  });
}

export function useTaxSummary(
  businessId: string,
  year: number,
  quarter?: number,
) {
  return useQuery<TaxSummary>({
    queryKey: ["tax-summary", businessId, year, quarter],
    queryFn: () => getTaxSummary(businessId, year, quarter),
    enabled: !!businessId && !!year,
  });
}

export function useBookkeepingTransactions(
  businessId: string,
  dateRange: DateRange,
) {
  return useQuery<BookkeepingTransaction[]>({
    queryKey: ["bookkeeping", businessId, dateRange],
    queryFn: () => getBookkeepingTransactions(businessId, dateRange),
    enabled: !!businessId && !!dateRange.from && !!dateRange.to,
  });
}

export function useStaffPerformance(businessId: string, dateRange: DateRange) {
  return useQuery<StaffPerformanceRow[]>({
    queryKey: ["staff-performance", businessId, dateRange],
    queryFn: () => getStaffPerformance(businessId, dateRange),
    enabled: !!businessId && !!dateRange.from && !!dateRange.to,
  });
}

export function useSupplierSpend(businessId: string, dateRange: DateRange) {
  return useQuery<SupplierSpendRow[]>({
    queryKey: ["supplier-spend", businessId, dateRange],
    queryFn: () => getSupplierSpend(businessId, dateRange),
    enabled: !!businessId && !!dateRange.from && !!dateRange.to,
  });
}

export function useExportReport(businessId: string) {
  return useMutation<
    string,
    Error,
    { reportType: string; dateRange: DateRange; format: "csv" | "json" }
  >({
    mutationFn: ({ reportType, dateRange, format }) =>
      exportReport(businessId, reportType, dateRange, format),
    onSuccess: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  });
}
