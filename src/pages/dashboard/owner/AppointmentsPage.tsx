import { useState, useMemo, useCallback } from "react";
import { useAuth, useTenant } from "../../../hooks/useAuth";
import EmptyState from "../../../components/EmptyState";
import {
  useAppointments,
  useAppointment,
  useCreateAppointment,
  useUpdateAppointmentStatus,
  useDashboardKPIs,
  useCalendar,
} from "../../../hooks/useAppointments";
import { formatAmount } from "../../../lib/stripe";
import type {
  AppointmentFilters,
  AppointmentStatus,
  AppointmentWithRelations,
  CalendarEntry,
  CreateAppointmentData,
} from "../../../types/api";

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function useDebounce(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useState(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  });
  // Simple effect-like via useMemo
  useMemo(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const statusConfig: Record<string, { label: string; className: string }> = {
  pending: { label: "Pending", className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" },
  confirmed: { label: "Confirmed", className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  in_progress: { label: "In Progress", className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  completed: { label: "Completed", className: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200" },
  cancelled: { label: "Cancelled", className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200" },
  no_show: { label: "No Show", className: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200" },
};

function StatusBadge({ status }: { status: string }) {
  const cfg = statusConfig[status] ?? { label: status, className: "bg-muted" };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// KPI card
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

// ---------------------------------------------------------------------------
// Appointment list view
// ---------------------------------------------------------------------------

function AppointmentListView({
  appointments,
  onSelect,
  selectedId,
}: {
  appointments: AppointmentWithRelations[];
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  if (appointments.length === 0) {
    return (
      <EmptyState
        icon="📅"
        title="No appointments found"
        description="No appointments match your current filters. Try adjusting the date range or status."
      />
    );
  }

  return (
    <div className="space-y-2">
      {appointments.map((appt) => (
        <button
          key={appt.id}
          onClick={() => onSelect(appt.id)}
          className={`w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent ${
            selectedId === appt.id ? "border-primary bg-primary/5" : ""
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-medium">
                {appt.client.first_name.charAt(0)}
                {appt.client.last_name.charAt(0)}
              </div>
              <div>
                <p className="text-sm font-medium">
                  {appt.client.first_name} {appt.client.last_name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {appt.service.name}
                  {appt.staff ? ` · ${appt.staff.display_name}` : ""}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={appt.status} />
              {appt.is_walk_in && (
                <span className="rounded bg-violet-100 px-1.5 py-0.5 text-xs font-medium text-violet-700 dark:bg-violet-900 dark:text-violet-200">
                  Walk-in
                </span>
              )}
            </div>
          </div>
          <div className="mt-1 flex gap-4 text-xs text-muted-foreground">
            <span>
              {new Date(appt.starts_at).toLocaleDateString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
              })}
            </span>
            <span>
              {new Date(appt.starts_at).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
              {" – "}
              {new Date(appt.ends_at).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            <span className="font-mono">{appt.booking_reference}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar view (day grid)
// ---------------------------------------------------------------------------

function AppointmentCalendarView({
  entries,
  onSelect,
}: {
  entries: CalendarEntry[];
  onSelect: (id: string) => void;
}) {
  const hours = Array.from({ length: 14 }, (_, i) => i + 7); // 07:00–20:00

  return (
    <div className="overflow-auto">
      <div className="min-w-[600px]">
        {hours.map((hour) => {
          const hourEntries = entries.filter(
            (e) => new Date(e.starts_at).getHours() === hour,
          );
          return (
            <div key={hour} className="flex border-b">
              <div className="w-16 shrink-0 py-3 text-right text-xs text-muted-foreground pr-3">
                {String(hour).padStart(2, "0")}:00
              </div>
              <div className="flex min-h-[3rem] flex-1 flex-wrap gap-1 py-1">
                {hourEntries.map((entry) => (
                  <button
                    key={entry.appointment_id}
                    onClick={() => onSelect(entry.appointment_id)}
                    className="rounded bg-primary/10 px-2 py-1 text-left text-xs hover:bg-primary/20"
                  >
                    <span className="font-medium">
                      {entry.client_first_name} {entry.client_last_name}
                    </span>
                    <span className="ml-1 text-muted-foreground">
                      · {entry.service_name}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appointment detail panel
// ---------------------------------------------------------------------------

function AppointmentDetailPanel({
  appointmentId,
  onClose,
}: {
  appointmentId: string;
  onClose: () => void;
}) {
  const { data: appt, isLoading } = useAppointment(appointmentId);
  const updateStatus = useUpdateAppointmentStatus();
  const [reason, setReason] = useState("");

  if (isLoading || !appt) {
    return (
      <div className="animate-pulse space-y-3 p-6">
        <div className="h-6 w-48 rounded bg-muted" />
        <div className="h-40 rounded bg-muted" />
      </div>
    );
  }

  function handleStatusChange(newStatus: AppointmentStatus) {
    updateStatus.mutate(
      { id: appointmentId, status: newStatus, reason: reason || undefined },
      { onSuccess: () => setReason("") },
    );
  }

  const canTransition: Partial<Record<string, AppointmentStatus[]>> = {
    pending: ["confirmed", "cancelled"],
    confirmed: ["in_progress", "cancelled", "no_show"],
    in_progress: ["completed"],
  };
  const transitions = canTransition[appt.status] ?? [];

  return (
    <div className="space-y-4 border-l bg-card p-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-lg font-semibold">
            {appt.client.first_name} {appt.client.last_name}
          </h3>
          <p className="text-sm text-muted-foreground">{appt.service.name}</p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          ✕
        </button>
      </div>

      <StatusBadge status={appt.status} />

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Date</dt>
          <dd>{new Date(appt.starts_at).toLocaleDateString()}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Time</dt>
          <dd>
            {new Date(appt.starts_at).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Duration</dt>
          <dd>{appt.duration_minutes} min</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Staff</dt>
          <dd>{appt.staff?.display_name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Reference</dt>
          <dd className="font-mono">{appt.booking_reference}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Source</dt>
          <dd className="capitalize">{appt.booking_source.replace("_", " ")}</dd>
        </div>
      </dl>

      {appt.notes && (
        <div className="text-sm">
          <p className="font-medium">Notes</p>
          <p className="text-muted-foreground">{appt.notes}</p>
        </div>
      )}
      {appt.internal_notes && (
        <div className="text-sm">
          <p className="font-medium">Internal notes</p>
          <p className="text-muted-foreground">{appt.internal_notes}</p>
        </div>
      )}

      {/* Payment */}
      {appt.payment && (
        <div className="rounded border p-3 text-sm">
          <p className="font-medium">Payment</p>
          <p className="capitalize text-muted-foreground">
            {appt.payment.status} · {appt.payment.method}
          </p>
        </div>
      )}

      {/* Status log */}
      {appt.status_log.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">History</p>
          <div className="mt-1 space-y-1">
            {appt.status_log.map((log) => (
              <div key={log.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {log.old_status ?? "—"} → {log.new_status}
                </span>
                {log.reason && <span>· {log.reason}</span>}
                <span>
                  · {new Date(log.created_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status action buttons */}
      {transitions.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          {(transitions.includes("cancelled") || transitions.includes("no_show")) && (
            <input
              type="text"
              placeholder="Reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            />
          )}
          <div className="flex flex-wrap gap-2">
            {transitions.map((s) => (
              <button
                key={s}
                onClick={() => handleStatusChange(s)}
                disabled={updateStatus.isPending}
                className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                  s === "cancelled" || s === "no_show"
                    ? "border border-destructive/30 text-destructive hover:bg-destructive/10"
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                }`}
              >
                {statusConfig[s]?.label ?? s}
              </button>
            ))}
          </div>
          {updateStatus.error && (
            <p className="text-xs text-destructive">{updateStatus.error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New/Walk-in booking dialog (inline)
// ---------------------------------------------------------------------------

function NewBookingPanel({
  businessId,
  isWalkIn,
  onClose,
}: {
  businessId: string;
  isWalkIn: boolean;
  onClose: () => void;
}) {
  const createAppt = useCreateAppointment(businessId);
  const [form, setForm] = useState<Partial<CreateAppointmentData>>({
    is_walk_in: isWalkIn,
    booking_source: isWalkIn ? "walk_in" : "staff",
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createAppt.mutate(form as CreateAppointmentData, {
      onSuccess: onClose,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 border-l bg-card p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {isWalkIn ? "Walk-in" : "New Booking"}
        </h3>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          ✕
        </button>
      </div>

      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">Client ID</label>
          <input
            type="text"
            required
            value={form.client_id ?? ""}
            onChange={(e) => setForm({ ...form, client_id: e.target.value })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Client UUID"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Service ID</label>
          <input
            type="text"
            required
            value={form.service_id ?? ""}
            onChange={(e) => setForm({ ...form, service_id: e.target.value })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Service UUID"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Staff (optional)</label>
          <input
            type="text"
            value={form.staff_profile_id ?? ""}
            onChange={(e) =>
              setForm({ ...form, staff_profile_id: e.target.value || null })
            }
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="Staff UUID"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">Start time</label>
            <input
              type="datetime-local"
              required
              value={form.starts_at ?? ""}
              onChange={(e) => setForm({ ...form, starts_at: new Date(e.target.value).toISOString() })}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Duration (min)</label>
            <input
              type="number"
              required
              min={5}
              value={form.duration_minutes ?? ""}
              onChange={(e) => setForm({ ...form, duration_minutes: Number(e.target.value) })}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium">Price</label>
          <input
            type="number"
            required
            min={0}
            step={0.01}
            value={form.price ?? ""}
            onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Notes</label>
          <textarea
            value={form.notes ?? ""}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            rows={2}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>

      {createAppt.error && (
        <p className="text-sm text-destructive">{createAppt.error.message}</p>
      )}

      <button
        type="submit"
        disabled={createAppt.isPending}
        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {createAppt.isPending
          ? "Creating…"
          : isWalkIn
            ? "Add walk-in"
            : "Create booking"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Status filter chips
// ---------------------------------------------------------------------------

const allStatuses: AppointmentStatus[] = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
];

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function AppointmentsPage() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId ?? "";

  // ── Filter state ──────────────────────────────────────────
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebounce(searchInput, 300);
  const [statusFilter, setStatusFilter] = useState<AppointmentStatus[]>([]);
  const [staffFilter, setStaffFilter] = useState<string | undefined>();
  const [dateFrom, setDateFrom] = useState(
    () => new Date().toISOString().split("T")[0],
  );
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().split("T")[0];
  });
  const [page, setPage] = useState(1);

  const filters: AppointmentFilters = useMemo(
    () => ({
      dateFrom,
      dateTo,
      status: statusFilter.length > 0 ? statusFilter : undefined,
      staffId: staffFilter,
      search: debouncedSearch || undefined,
      page,
      limit: 25,
    }),
    [dateFrom, dateTo, statusFilter, staffFilter, debouncedSearch, page],
  );

  // ── Data ──────────────────────────────────────────────────
  const { data: kpis } = useDashboardKPIs(businessId);
  const { data: appointmentData, isLoading } = useAppointments(businessId, filters);
  const { data: calendarEntries } = useCalendar(
    businessId,
    dateFrom,
    dateTo,
    staffFilter,
  );

  // ── Panel state ───────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewBooking, setShowNewBooking] = useState<false | "booking" | "walkin">(false);

  const toggleStatus = useCallback((s: AppointmentStatus) => {
    setStatusFilter((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
    setPage(1);
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* ── KPI row ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <StatCard
          label="Today's appointments"
          value={kpis?.today.total ?? "—"}
          sub={kpis ? `${kpis.today.remaining} remaining` : undefined}
        />
        <StatCard
          label="Completed today"
          value={kpis?.today.completed ?? "—"}
        />
        <StatCard
          label="Walk-ins today"
          value={kpis?.today.walk_ins ?? "—"}
        />
        <StatCard
          label="Cancelled today"
          value={kpis?.today.cancelled ?? "—"}
        />
      </div>

      {/* ── Toolbar ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 border-b px-4 pb-3">
        {/* Search */}
        <input
          type="text"
          placeholder="Search client name or email…"
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setPage(1);
          }}
          className="w-64 rounded-md border bg-background px-3 py-1.5 text-sm"
        />

        {/* Date range */}
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => {
            setDateFrom(e.target.value);
            setPage(1);
          }}
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
        />
        <span className="text-muted-foreground">–</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => {
            setDateTo(e.target.value);
            setPage(1);
          }}
          className="rounded-md border bg-background px-2 py-1.5 text-sm"
        />

        {/* View toggle */}
        <div className="ml-auto flex gap-1 rounded-md border p-0.5">
          <button
            onClick={() => setViewMode("list")}
            className={`rounded px-3 py-1 text-sm ${
              viewMode === "list" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            }`}
          >
            List
          </button>
          <button
            onClick={() => setViewMode("calendar")}
            className={`rounded px-3 py-1 text-sm ${
              viewMode === "calendar" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            }`}
          >
            Calendar
          </button>
        </div>

        {/* Action buttons */}
        <button
          onClick={() => {
            setShowNewBooking("booking");
            setSelectedId(null);
          }}
          className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + New Booking
        </button>
        <button
          onClick={() => {
            setShowNewBooking("walkin");
            setSelectedId(null);
          }}
          className="rounded-md border px-4 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Walk-in
        </button>
      </div>

      {/* ── Status filter chips ──────────────────────────────── */}
      <div className="flex flex-wrap gap-1.5 px-4 pt-3">
        {allStatuses.map((s) => (
          <button
            key={s}
            onClick={() => toggleStatus(s)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              statusFilter.includes(s)
                ? statusConfig[s].className
                : "bg-muted hover:bg-muted/80"
            }`}
          >
            {statusConfig[s].label}
          </button>
        ))}
        {statusFilter.length > 0 && (
          <button
            onClick={() => {
              setStatusFilter([]);
              setPage(1);
            }}
            className="rounded-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>

      {/* ── Content area ─────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Main content */}
        <div className="flex-1 overflow-auto p-4">
          {isLoading ? (
            <div className="space-y-2 animate-pulse">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-16 rounded-lg bg-muted" />
              ))}
            </div>
          ) : viewMode === "list" ? (
            <>
              <AppointmentListView
                appointments={appointmentData?.appointments ?? []}
                onSelect={(id) => {
                  setSelectedId(id);
                  setShowNewBooking(false);
                }}
                selectedId={selectedId}
              />
              {/* Pagination */}
              {appointmentData && appointmentData.total > 25 && (
                <div className="mt-4 flex items-center justify-between text-sm">
                  <p className="text-muted-foreground">
                    {appointmentData.total} total
                  </p>
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
                      disabled={page * 25 >= appointmentData.total}
                      className="rounded border px-3 py-1 hover:bg-muted disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <AppointmentCalendarView
              entries={calendarEntries ?? []}
              onSelect={(id) => {
                setSelectedId(id);
                setShowNewBooking(false);
              }}
            />
          )}
        </div>

        {/* Side panel */}
        {selectedId && !showNewBooking && (
          <div className="w-96 shrink-0 overflow-auto">
            <AppointmentDetailPanel
              appointmentId={selectedId}
              onClose={() => setSelectedId(null)}
            />
          </div>
        )}
        {showNewBooking && (
          <div className="w-96 shrink-0 overflow-auto">
            <NewBookingPanel
              businessId={businessId}
              isWalkIn={showNewBooking === "walkin"}
              onClose={() => setShowNewBooking(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
