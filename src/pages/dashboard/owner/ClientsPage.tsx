import { useState, useMemo, useCallback, useRef } from "react";
import { useAuth, useTenant } from "../../../hooks/useAuth";
import EmptyState from "../../../components/EmptyState";
import {
  useClients,
  useClient,
  useCreateClient,
  useUpdateClient,
  useUpdateClientNotes,
  useImportClients,
} from "../../../hooks/useClients";
import { formatAmount } from "../../../lib/stripe";
import type {
  ClientFilters,
  ClientWithStats,
  CreateClientData,
  ImportRow,
} from "../../../types/api";

// ---------------------------------------------------------------------------
// Source badge
// ---------------------------------------------------------------------------

const sourceConfig: Record<string, { label: string; className: string }> = {
  manual: { label: "Manual", className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200" },
  import: { label: "Import", className: "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200" },
  marketplace: { label: "Online", className: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" },
  walk_in: { label: "Walk-in", className: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200" },
};

function SourceBadge({ source }: { source: string }) {
  const cfg = sourceConfig[source] ?? { label: source, className: "bg-muted" };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}>
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client list item
// ---------------------------------------------------------------------------

function ClientRow({
  client,
  selected,
  onSelect,
}: {
  client: ClientWithStats;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent ${
        selected ? "border-primary bg-primary/5" : ""
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-medium">
            {client.first_name.charAt(0)}
            {client.last_name.charAt(0)}
          </div>
          <div>
            <p className="text-sm font-medium">
              {client.first_name} {client.last_name}
            </p>
            <p className="text-xs text-muted-foreground">
              {client.email ?? "No email"}
              {client.phone ? ` · ${client.phone}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <SourceBadge source={client.source} />
          {client.tags.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {client.tags.slice(0, 2).join(", ")}
              {client.tags.length > 2 && ` +${client.tags.length - 2}`}
            </span>
          )}
        </div>
      </div>
      <div className="mt-1 flex gap-4 text-xs text-muted-foreground">
        <span>{client.appointment_count} visits</span>
        <span>
          Last:{" "}
          {client.last_visit
            ? new Date(client.last_visit).toLocaleDateString()
            : "Never"}
        </span>
        <span>Spent: {formatAmount(client.total_spent, "EUR")}</span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Client detail panel
// ---------------------------------------------------------------------------

function ClientDetailPanel({
  clientId,
  onClose,
  onBookAppointment,
}: {
  clientId: string;
  onClose: () => void;
  onBookAppointment: (clientId: string) => void;
}) {
  const { data: client, isLoading } = useClient(clientId);
  const updateNotes = useUpdateClientNotes();
  const [notes, setNotes] = useState<string | null>(null);
  const notesInitialized = useRef(false);

  // Sync notes from server on first load
  if (client && !notesInitialized.current) {
    setNotes(client.notes ?? "");
    notesInitialized.current = true;
  }

  if (isLoading || !client) {
    return (
      <div className="animate-pulse space-y-3 p-6">
        <div className="h-6 w-48 rounded bg-muted" />
        <div className="h-40 rounded bg-muted" />
      </div>
    );
  }

  function handleSaveNotes() {
    if (notes === null) return;
    updateNotes.mutate({ id: clientId, notes });
  }

  return (
    <div className="space-y-4 border-l bg-card p-6 overflow-auto">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-lg font-medium">
            {client.first_name.charAt(0)}
            {client.last_name.charAt(0)}
          </div>
          <div>
            <h3 className="text-lg font-semibold">
              {client.first_name} {client.last_name}
            </h3>
            <SourceBadge source={client.source} />
          </div>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          ✕
        </button>
      </div>

      {/* Contact info */}
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-muted-foreground">Email</dt>
          <dd>{client.email ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Phone</dt>
          <dd>{client.phone ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Date of birth</dt>
          <dd>
            {client.date_of_birth
              ? new Date(client.date_of_birth).toLocaleDateString()
              : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Locale</dt>
          <dd className="uppercase">{client.preferred_locale}</dd>
        </div>
        {client.preferred_staff && (
          <div className="col-span-2">
            <dt className="text-muted-foreground">Preferred staff</dt>
            <dd>{client.preferred_staff.display_name}</dd>
          </div>
        )}
      </dl>

      {/* Tags */}
      {client.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {client.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Notes */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Notes</label>
        <textarea
          value={notes ?? ""}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="block w-full rounded-md border bg-background px-3 py-2 text-sm"
          placeholder="Add notes about this client…"
        />
        <button
          onClick={handleSaveNotes}
          disabled={updateNotes.isPending || notes === client.notes}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {updateNotes.isPending ? "Saving…" : "Save notes"}
        </button>
        {updateNotes.error && (
          <p className="text-xs text-destructive">{updateNotes.error.message}</p>
        )}
      </div>

      {/* Book appointment button */}
      <button
        onClick={() => onBookAppointment(clientId)}
        className="w-full rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
      >
        + Book Appointment
      </button>

      {/* Recent appointments */}
      {client.recent_appointments.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Recent appointments</p>
          <div className="space-y-1.5">
            {client.recent_appointments.map((appt) => (
              <div
                key={appt.id}
                className="rounded border p-2 text-sm"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium">{appt.service.name}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      appt.status === "completed"
                        ? "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200"
                        : appt.status === "cancelled"
                          ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                          : "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                    }`}
                  >
                    {appt.status}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(appt.starts_at).toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                  })}
                  {appt.staff ? ` · ${appt.staff.display_name}` : ""}
                  <span className="ml-1 font-mono">{appt.booking_reference}</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Client since{" "}
        {new Date(client.created_at).toLocaleDateString()}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New client form
// ---------------------------------------------------------------------------

function NewClientPanel({
  businessId,
  onClose,
}: {
  businessId: string;
  onClose: () => void;
}) {
  const createClient = useCreateClient(businessId);
  const [form, setForm] = useState<Partial<CreateClientData>>({});

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createClient.mutate(form as CreateClientData, {
      onSuccess: onClose,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 border-l bg-card p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">New Client</h3>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">
          ✕
        </button>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">First name</label>
            <input
              type="text"
              required
              value={form.first_name ?? ""}
              onChange={(e) => setForm({ ...form, first_name: e.target.value })}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Last name</label>
            <input
              type="text"
              required
              value={form.last_name ?? ""}
              onChange={(e) => setForm({ ...form, last_name: e.target.value })}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div>
          <label className="text-sm font-medium">Email</label>
          <input
            type="email"
            value={form.email ?? ""}
            onChange={(e) => setForm({ ...form, email: e.target.value || null })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Phone</label>
          <input
            type="tel"
            value={form.phone ?? ""}
            onChange={(e) => setForm({ ...form, phone: e.target.value || null })}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Date of birth</label>
          <input
            type="date"
            value={form.date_of_birth ?? ""}
            onChange={(e) =>
              setForm({ ...form, date_of_birth: e.target.value || null })
            }
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Tags (comma separated)</label>
          <input
            type="text"
            value={(form.tags ?? []).join(", ")}
            onChange={(e) =>
              setForm({
                ...form,
                tags: e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            placeholder="VIP, Regular"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Notes</label>
          <textarea
            value={form.notes ?? ""}
            onChange={(e) => setForm({ ...form, notes: e.target.value || null })}
            rows={2}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>
      </div>

      {createClient.error && (
        <p className="text-sm text-destructive">{createClient.error.message}</p>
      )}

      <button
        type="submit"
        disabled={createClient.isPending}
        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {createClient.isPending ? "Creating…" : "Add Client"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Import dialog
// ---------------------------------------------------------------------------

function ImportPanel({
  businessId,
  onClose,
}: {
  businessId: string;
  onClose: () => void;
}) {
  const importMutation = useImportClients(businessId);
  const [csvText, setCsvText] = useState("");

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setCsvText((ev.target?.result as string) ?? "");
    reader.readAsText(file);
  }

  function parseCsv(text: string): ImportRow[] {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return [];

    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    return lines.slice(1).map((line) => {
      const values = line.split(",").map((v) => v.trim());
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = values[i] ?? "";
      });
      return {
        first_name: row.first_name ?? row.firstname ?? "",
        last_name: row.last_name ?? row.lastname ?? "",
        email: row.email || null,
        phone: row.phone || null,
        date_of_birth: row.date_of_birth || row.dob || null,
        notes: row.notes || null,
        tags: row.tags ? row.tags.split(";").map((t) => t.trim()) : [],
      };
    });
  }

  function handleImport() {
    const rows = parseCsv(csvText);
    if (rows.length === 0) return;
    importMutation.mutate(rows);
  }

  return (
    <div className="space-y-4 border-l bg-card p-6">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Import Clients</h3>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          ✕
        </button>
      </div>

      <p className="text-sm text-muted-foreground">
        Upload a CSV file with columns: first_name, last_name, email, phone,
        date_of_birth, notes, tags (semicolon-separated).
      </p>

      <input
        type="file"
        accept=".csv,text/csv"
        onChange={handleFileUpload}
        className="block w-full text-sm"
      />

      {csvText && (
        <div className="rounded border bg-muted/50 p-3">
          <p className="text-xs text-muted-foreground">
            {parseCsv(csvText).length} rows detected
          </p>
          <pre className="mt-1 max-h-40 overflow-auto text-xs">
            {csvText.slice(0, 500)}
            {csvText.length > 500 && "…"}
          </pre>
        </div>
      )}

      {importMutation.data && (
        <div className="rounded border p-3 text-sm">
          <p className="font-medium">Import complete</p>
          <div className="mt-1 grid grid-cols-3 gap-2 text-xs">
            <div>
              <span className="text-green-600 font-medium">{importMutation.data.imported}</span> imported
            </div>
            <div>
              <span className="text-blue-600 font-medium">{importMutation.data.updated}</span> updated
            </div>
            <div>
              <span className="text-amber-600 font-medium">{importMutation.data.skipped}</span> skipped
            </div>
          </div>
          {importMutation.data.errors.length > 0 && (
            <div className="mt-2 max-h-24 overflow-auto text-xs text-destructive">
              {importMutation.data.errors.map((err, i) => (
                <p key={i}>
                  Row {err.row}: {err.reason}
                </p>
              ))}
            </div>
          )}
        </div>
      )}

      {importMutation.error && (
        <p className="text-sm text-destructive">{importMutation.error.message}</p>
      )}

      <button
        onClick={handleImport}
        disabled={importMutation.isPending || !csvText}
        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {importMutation.isPending ? "Importing…" : "Import"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ClientsPage() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId ?? "";

  // ── Filter state ──────────────────────────────────────────
  const [searchInput, setSearchInput] = useState("");
  const [tagsFilter, setTagsFilter] = useState<string[]>([]);
  const [page, setPage] = useState(1);

  const filters: ClientFilters = useMemo(
    () => ({
      tags: tagsFilter.length > 0 ? tagsFilter : undefined,
      page,
      limit: 25,
    }),
    [tagsFilter, page],
  );

  const { data: clientData, isLoading } = useClients(businessId, filters, searchInput);

  // ── Panel state ───────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState<false | "new" | "import">(false);

  const handleBookAppointment = useCallback((clientId: string) => {
    // Navigate to appointments page with pre-filled client
    // For now, open in new tab as a placeholder
    window.location.hash = `#/owner/appointments?client=${clientId}`;
  }, []);

  return (
    <div className="flex h-full flex-col">
      {/* ── KPI row ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <StatCard
          label="Total clients"
          value={clientData?.total ?? "—"}
        />
        <StatCard
          label="Showing"
          value={clientData?.clients.length ?? "—"}
        />
      </div>

      {/* ── Toolbar ──────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 border-b px-4 pb-3">
        <input
          type="text"
          placeholder="Search by name, email, or phone…"
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setPage(1);
          }}
          className="w-72 rounded-md border bg-background px-3 py-1.5 text-sm"
        />

        <div className="ml-auto flex gap-2">
          <button
            onClick={() => {
              setShowPanel("import");
              setSelectedId(null);
            }}
            className="rounded-md border px-4 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Import CSV
          </button>
          <button
            onClick={() => {
              setShowPanel("new");
              setSelectedId(null);
            }}
            className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            + New Client
          </button>
        </div>
      </div>

      {/* ── Content area ─────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Client list */}
        <div className="flex-1 overflow-auto p-4">
          {isLoading ? (
            <div className="space-y-2 animate-pulse">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-16 rounded-lg bg-muted" />
              ))}
            </div>
          ) : clientData?.clients.length === 0 ? (
            <EmptyState
              icon="👥"
              title="No clients found"
              description="No clients match your search. Try different keywords or add a new client."
            />
          ) : (
            <>
              <div className="space-y-2">
                {clientData?.clients.map((client) => (
                  <ClientRow
                    key={client.id}
                    client={client}
                    selected={selectedId === client.id}
                    onSelect={() => {
                      setSelectedId(client.id);
                      setShowPanel(false);
                    }}
                  />
                ))}
              </div>

              {/* Pagination */}
              {clientData && clientData.total > 25 && (
                <div className="mt-4 flex items-center justify-between text-sm">
                  <p className="text-muted-foreground">
                    {clientData.total} total
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
                      disabled={page * 25 >= clientData.total}
                      className="rounded border px-3 py-1 hover:bg-muted disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Side panel */}
        {selectedId && !showPanel && (
          <div className="w-96 shrink-0 overflow-auto">
            <ClientDetailPanel
              clientId={selectedId}
              onClose={() => setSelectedId(null)}
              onBookAppointment={handleBookAppointment}
            />
          </div>
        )}
        {showPanel === "new" && (
          <div className="w-96 shrink-0 overflow-auto">
            <NewClientPanel
              businessId={businessId}
              onClose={() => setShowPanel(false)}
            />
          </div>
        )}
        {showPanel === "import" && (
          <div className="w-96 shrink-0 overflow-auto">
            <ImportPanel
              businessId={businessId}
              onClose={() => setShowPanel(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
