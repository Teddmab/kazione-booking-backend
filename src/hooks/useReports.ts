import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getStaffPerformance } from "../services/financeService";
import { useRevenueSummary, useIncomeBreakdown } from "./useFinance";
import type {
  DateRange,
  IncomePeriod,
  ServiceRevenue,
  StaffPerformanceRow,
} from "../types/api";

// ---------------------------------------------------------------------------
// Staff performance report
// ---------------------------------------------------------------------------

export function useStaffPerformanceReport(
  businessId: string,
  dateRange: DateRange,
) {
  return useQuery<StaffPerformanceRow[]>({
    queryKey: ["report-staff-performance", businessId, dateRange],
    queryFn: () => getStaffPerformance(businessId, dateRange),
    enabled: !!businessId && !!dateRange.from && !!dateRange.to,
  });
}

// ---------------------------------------------------------------------------
// Service popularity — derived from revenue summary
// ---------------------------------------------------------------------------

export function useServicePopularityReport(
  businessId: string,
  dateRange: DateRange,
) {
  const { data: summary, ...rest } = useRevenueSummary(businessId, dateRange);

  const services: ServiceRevenue[] = useMemo(
    () =>
      (summary?.income_by_service ?? [])
        .slice()
        .sort((a, b) => b.count - a.count),
    [summary],
  );

  return { data: services, ...rest };
}

// ---------------------------------------------------------------------------
// Revenue report — wrapper around income breakdown
// ---------------------------------------------------------------------------

export function useRevenueReport(
  businessId: string,
  dateRange: DateRange,
  groupBy: "day" | "week" | "month" = "month",
) {
  return useIncomeBreakdown(businessId, dateRange, groupBy);
}
