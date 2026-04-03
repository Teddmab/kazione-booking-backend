import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth, useTenant } from "../../hooks/useAuth";
import { useDashboardKPIs } from "../../hooks/useAppointments";
import { useIncomeBreakdown, useStaffPerformance } from "../../hooks/useFinance";
import { formatAmount } from "../../lib/stripe";
import type { TopService, BusyHour, StaffPerformanceRow, IncomePeriod } from "../../types/api";

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  trend,
}: {
  label: string;
  value: string | number;
  sub?: string;
  trend?: "up" | "down" | "neutral";
}) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-bold">{value}</span>
        {trend && (
          <span
            className={`text-xs font-medium ${
              trend === "up"
                ? "text-green-600"
                : trend === "down"
                  ? "text-red-600"
                  : "text-muted-foreground"
            }`}
          >
            {trend === "up" ? "↑" : trend === "down" ? "↓" : "—"}
          </span>
        )}
      </div>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revenue chart (horizontal bars)
// ---------------------------------------------------------------------------

function RevenueChart({ data }: { data: IncomePeriod[] }) {
  const max = Math.max(...data.map((d) => d.amount), 1);
  return (
    <div className="space-y-2">
      {data.map((period) => (
        <div key={period.period} className="flex items-center gap-3 text-sm">
          <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
            {period.period}
          </span>
          <div className="flex-1">
            <div
              className="h-6 rounded bg-primary/80 transition-all"
              style={{ width: `${(period.amount / max) * 100}%` }}
            />
          </div>
          <span className="w-20 shrink-0 text-xs font-medium">
            €{period.amount.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top services chart
// ---------------------------------------------------------------------------

function TopServicesChart({ data }: { data: TopService[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="space-y-2">
      {data.map((svc) => (
        <div key={svc.service_id} className="flex items-center gap-3 text-sm">
          <span className="w-32 shrink-0 truncate">{svc.service_name}</span>
          <div className="flex-1">
            <div
              className="h-5 rounded bg-violet-500/70"
              style={{ width: `${(svc.count / max) * 100}%` }}
            />
          </div>
          <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">
            {svc.count}
          </span>
        </div>
      ))}
      {data.length === 0 && (
        <p className="text-sm text-muted-foreground">No data yet.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Busy hours heatmap
// ---------------------------------------------------------------------------

function BusyHoursChart({ data }: { data: BusyHour[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="flex flex-wrap gap-1">
      {Array.from({ length: 14 }, (_, i) => {
        const hour = i + 7;
        const entry = data.find((d) => d.hour === hour);
        const count = entry?.count ?? 0;
        const intensity = count / max;
        return (
          <div
            key={hour}
            title={`${hour}:00 — ${count} bookings`}
            className="flex h-10 w-10 items-center justify-center rounded text-xs font-medium"
            style={{
              backgroundColor: `rgba(var(--primary-rgb, 59, 130, 246), ${0.1 + intensity * 0.8})`,
              color: intensity > 0.5 ? "white" : undefined,
            }}
          >
            {hour}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff performance table
// ---------------------------------------------------------------------------

function StaffPerformancePanel({ data }: { data: StaffPerformanceRow[] }) {
  return (
    <div className="overflow-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-4">Staff</th>
            <th className="py-2 pr-4 text-right">Bookings</th>
            <th className="py-2 pr-4 text-right">Revenue</th>
            <th className="py-2 pr-4 text-right">Clients</th>
            <th className="py-2 pr-4 text-right">Rating</th>
            <th className="py-2 text-right">Completion</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.staff_profile_id} className="border-b last:border-0">
              <td className="py-2 pr-4 font-medium">{row.display_name}</td>
              <td className="py-2 pr-4 text-right">{row.bookings}</td>
              <td className="py-2 pr-4 text-right">€{row.revenue.toLocaleString()}</td>
              <td className="py-2 pr-4 text-right">{row.unique_clients}</td>
              <td className="py-2 pr-4 text-right">
                {row.avg_rating > 0 ? `★ ${row.avg_rating.toFixed(1)}` : "—"}
              </td>
              <td className="py-2 text-right">
                {(row.completion_rate * 100).toFixed(0)}%
              </td>
            </tr>
          ))}
          {data.length === 0 && (
            <tr>
              <td colSpan={6} className="py-4 text-center text-muted-foreground">
                No data yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

export default function OwnerDashboard() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId ?? "";

  // ── KPIs ──────────────────────────────────────────────────
  const { data: kpis, isLoading: kpisLoading } = useDashboardKPIs(businessId);

  // ── Revenue chart — last 12 weeks ─────────────────────────
  const incomeDateRange = useMemo(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 84); // 12 weeks
    return {
      from: start.toISOString().split("T")[0],
      to: end.toISOString().split("T")[0],
    };
  }, []);

  const { data: incomeData } = useIncomeBreakdown(
    businessId,
    incomeDateRange,
    "week",
  );

  // ── Staff performance — last 30 days ──────────────────────
  const perfDateRange = useMemo(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    return {
      from: start.toISOString().split("T")[0],
      to: end.toISOString().split("T")[0],
    };
  }, []);

  const { data: staffPerf } = useStaffPerformance(businessId, perfDateRange);

  // ── Loading skeleton ──────────────────────────────────────
  if (kpisLoading) {
    return (
      <div className="animate-pulse space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-lg bg-muted" />
          ))}
        </div>
        <div className="h-64 rounded-lg bg-muted" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <Link
          to="/owner/appointments"
          className="text-sm text-primary hover:underline"
        >
          View all appointments →
        </Link>
      </div>

      {/* ── KPI cards ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Today's bookings"
          value={kpis?.today.total ?? 0}
          sub={kpis ? `${kpis.today.remaining} remaining` : undefined}
        />
        <StatCard
          label="This month"
          value={kpis?.this_month.total ?? 0}
          sub={
            kpis
              ? `€${kpis.this_month.revenue.toLocaleString()} revenue`
              : undefined
          }
        />
        <StatCard
          label="Active clients"
          value={kpis?.active_clients_total ?? 0}
        />
        <StatCard
          label="Avg rating"
          value={kpis?.avg_rating ? `★ ${kpis.avg_rating.toFixed(1)}` : "—"}
          sub={
            kpis
              ? `${(kpis.completion_rate_30d * 100).toFixed(0)}% completion rate`
              : undefined
          }
        />
      </div>

      {/* ── Charts row ───────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Revenue chart */}
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Revenue (last 12 weeks)</h2>
          <div className="mt-4">
            {incomeData ? (
              <RevenueChart data={incomeData} />
            ) : (
              <div className="h-48 animate-pulse rounded bg-muted" />
            )}
          </div>
        </div>

        {/* Top services */}
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Top services (30 days)</h2>
          <div className="mt-4">
            <TopServicesChart data={kpis?.top_services_30d ?? []} />
          </div>
        </div>
      </div>

      {/* ── Second row ───────────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Busy hours */}
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Busiest hours (30 days)</h2>
          <div className="mt-4">
            <BusyHoursChart data={kpis?.busy_hours_30d ?? []} />
          </div>
        </div>

        {/* Staff on today */}
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Staff on today</h2>
          <div className="mt-4 space-y-2">
            {(kpis?.staff_on_today ?? []).map((s) => (
              <div key={s.staff_profile_id} className="flex items-center gap-3">
                {s.avatar_url ? (
                  <img
                    src={s.avatar_url}
                    alt=""
                    className="h-8 w-8 rounded-full object-cover"
                  />
                ) : (
                  <div
                    className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium text-white"
                    style={{ backgroundColor: s.calendar_color ?? "#6366f1" }}
                  >
                    {s.display_name.charAt(0)}
                  </div>
                )}
                <span className="text-sm">{s.display_name}</span>
              </div>
            ))}
            {(kpis?.staff_on_today ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No staff scheduled today.</p>
            )}
          </div>
        </div>
      </div>

      {/* ── Staff performance ────────────────────────────────── */}
      <div className="rounded-lg border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Staff performance (30 days)</h2>
        <div className="mt-4">
          <StaffPerformancePanel data={staffPerf ?? []} />
        </div>
      </div>

      {/* ── Upcoming today ───────────────────────────────────── */}
      {kpis && kpis.upcoming_today.length > 0 && (
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-semibold">Upcoming today</h2>
          <div className="mt-3 space-y-2">
            {kpis.upcoming_today.map((appt) => (
              <div
                key={appt.id}
                className="flex items-center justify-between rounded-md border p-3 text-sm"
              >
                <div>
                  <p className="font-medium">{appt.client_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {appt.service_name} · {appt.staff_name}
                  </p>
                </div>
                <div className="text-right">
                  <p>
                    {new Date(appt.starts_at).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono">
                    {appt.booking_reference}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
