import { useState } from "react";
import { useAuth, useTenant } from "../../../hooks/useAuth";
import {
  useDateRange,
  useExportReport,
  DATE_RANGE_PRESETS,
} from "../../../hooks/useFinance";
import type { DateRangePreset } from "../../../hooks/useFinance";
import {
  useStaffPerformanceReport,
  useServicePopularityReport,
  useRevenueReport,
} from "../../../hooks/useReports";
import { formatAmount } from "../../../lib/stripe";
import type { DateRange } from "../../../types/api";

// ---------------------------------------------------------------------------
// Shared
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
// Report cards
// ---------------------------------------------------------------------------

function StaffPerformanceCard({
  businessId,
  dateRange,
}: {
  businessId: string;
  dateRange: DateRange;
}) {
  const { data: staff, isLoading } = useStaffPerformanceReport(businessId, dateRange);
  const exportMutation = useExportReport(businessId);

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-sm font-medium">Staff Performance</h3>
        <button
          onClick={() =>
            exportMutation.mutate({ reportType: "staff_payroll", dateRange, format: "csv" })
          }
          disabled={exportMutation.isPending}
          className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>
      <div className="p-4">
        {isLoading ? (
          <div className="animate-pulse space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-10 rounded bg-muted" />)}
          </div>
        ) : (staff ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No staff data.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="px-2 py-1.5 font-medium">Name</th>
                <th className="px-2 py-1.5 text-right font-medium">Bookings</th>
                <th className="px-2 py-1.5 text-right font-medium">Revenue</th>
                <th className="px-2 py-1.5 text-right font-medium">Commission</th>
                <th className="px-2 py-1.5 text-right font-medium">Rating</th>
              </tr>
            </thead>
            <tbody>
              {(staff ?? []).map((s) => (
                <tr key={s.staff_profile_id} className="border-b hover:bg-muted/50">
                  <td className="px-2 py-1.5">{s.display_name}</td>
                  <td className="px-2 py-1.5 text-right">{s.bookings}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatAmount(s.revenue, "EUR")}</td>
                  <td className="px-2 py-1.5 text-right font-mono">{formatAmount(s.commission_amount, "EUR")}</td>
                  <td className="px-2 py-1.5 text-right">{s.avg_rating > 0 ? s.avg_rating.toFixed(1) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function ServicePopularityCard({
  businessId,
  dateRange,
}: {
  businessId: string;
  dateRange: DateRange;
}) {
  const { data: services, isLoading } = useServicePopularityReport(businessId, dateRange);

  const maxCount = Math.max(...(services ?? []).map((s) => s.count), 1);

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-medium">Service Popularity</h3>
      </div>
      <div className="p-4">
        {isLoading ? (
          <div className="animate-pulse space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-8 rounded bg-muted" />)}
          </div>
        ) : (services ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No service data.</p>
        ) : (
          <div className="space-y-2">
            {(services ?? []).map((s) => (
              <div key={s.service_id} className="flex items-center gap-3 text-sm">
                <span className="w-32 shrink-0 truncate">{s.service_name}</span>
                <div className="flex-1">
                  <div
                    className="h-5 rounded bg-primary/20"
                    style={{ width: `${(s.count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="w-12 text-right text-xs text-muted-foreground">{s.count}</span>
                <span className="w-20 text-right text-xs font-mono">{formatAmount(s.total, "EUR")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RevenueReportCard({
  businessId,
  dateRange,
}: {
  businessId: string;
  dateRange: DateRange;
}) {
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month">("week");
  const { data: periods, isLoading } = useRevenueReport(businessId, dateRange, groupBy);
  const exportMutation = useExportReport(businessId);

  const maxAmount = Math.max(...(periods ?? []).map((p) => p.amount), 1);

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-sm font-medium">Revenue Trend</h3>
        <div className="flex items-center gap-2">
          <div className="flex gap-0.5 rounded-md border p-0.5">
            {(["day", "week", "month"] as const).map((g) => (
              <button
                key={g}
                onClick={() => setGroupBy(g)}
                className={`rounded px-2 py-0.5 text-xs capitalize ${
                  groupBy === g ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                {g}
              </button>
            ))}
          </div>
          <button
            onClick={() =>
              exportMutation.mutate({ reportType: "income", dateRange, format: "csv" })
            }
            disabled={exportMutation.isPending}
            className="rounded-md border px-3 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>
      <div className="p-4">
        {isLoading ? (
          <div className="h-48 animate-pulse rounded bg-muted" />
        ) : (periods ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No revenue data.</p>
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
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main ReportsPage
// ---------------------------------------------------------------------------

export default function ReportsPage() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId ?? "";

  const { dateRange, preset, selectPreset, setCustom } = useDateRange("last30d");

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="space-y-3 border-b p-4">
        <h1 className="text-xl font-bold">Reports</h1>
        <DateRangePicker
          preset={preset}
          dateRange={dateRange}
          selectPreset={selectPreset}
          setCustom={setCustom}
        />
      </div>

      {/* ── Report cards ──────────────────────────────────────── */}
      <div className="flex-1 overflow-auto p-4 space-y-6">
        <RevenueReportCard businessId={businessId} dateRange={dateRange} />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <StaffPerformanceCard businessId={businessId} dateRange={dateRange} />
          <ServicePopularityCard businessId={businessId} dateRange={dateRange} />
        </div>
      </div>
    </div>
  );
}
