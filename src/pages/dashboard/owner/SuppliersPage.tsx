import { useState, useMemo, useCallback } from "react";
import { useAuth, useTenant } from "../../../hooks/useAuth";
import EmptyState from "../../../components/EmptyState";
import {
  useSuppliers,
  useSupplier,
  useCreateSupplier,
  useUpdateSupplier,
  useSupplierOrders,
  useCreateSupplierOrder,
  useUpdateOrderStatus,
} from "../../../hooks/useSuppliers";
import { formatAmount } from "../../../lib/stripe";
import type {
  CreateOrderData,
  CreateOrderItemData,
  CreateSupplierData,
  SupplierFilters,
  SupplierOrderRow,
  SupplierOrderStatus,
  SupplierWithStats,
} from "../../../types/api";

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const orderStatusConfig: Record<
  SupplierOrderStatus,
  { label: string; className: string }
> = {
  draft: {
    label: "Draft",
    className: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
  },
  ordered: {
    label: "Ordered",
    className: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  },
  received: {
    label: "Received",
    className:
      "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  },
  cancelled: {
    label: "Cancelled",
    className: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  },
};

function StatusBadge({ status }: { status: SupplierOrderStatus }) {
  const cfg = orderStatusConfig[status];
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${cfg.className}`}
    >
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg border bg-card p-4 shadow-sm">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplier list row
// ---------------------------------------------------------------------------

function SupplierRow({
  supplier,
  selected,
  onSelect,
}: {
  supplier: SupplierWithStats;
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
        <div>
          <p className="text-sm font-medium">{supplier.name}</p>
          <p className="text-xs text-muted-foreground">
            {supplier.contact_name ?? "No contact"}
            {supplier.email ? ` · ${supplier.email}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!supplier.is_active && (
            <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900 dark:text-red-200">
              Inactive
            </span>
          )}
          {supplier.open_orders > 0 && (
            <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900 dark:text-blue-200">
              {supplier.open_orders} open
            </span>
          )}
        </div>
      </div>
      <div className="mt-1 flex gap-4 text-xs text-muted-foreground">
        <span>Spent: {formatAmount(supplier.total_spent, "EUR")}</span>
        <span>
          Since {new Date(supplier.created_at).toLocaleDateString()}
        </span>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Supplier detail panel
// ---------------------------------------------------------------------------

function SupplierDetailPanel({
  supplierId,
  businessId,
  onClose,
}: {
  supplierId: string;
  businessId: string;
  onClose: () => void;
}) {
  const { data: supplier, isLoading } = useSupplier(supplierId);
  const updateMutation = useUpdateSupplier(businessId);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<CreateSupplierData>>({});

  const handleStartEdit = useCallback(() => {
    if (!supplier) return;
    setForm({
      name: supplier.name,
      contact_name: supplier.contact_name,
      email: supplier.email,
      phone: supplier.phone,
      website: supplier.website,
      address: supplier.address,
      notes: supplier.notes,
    });
    setEditing(true);
  }, [supplier]);

  const handleSave = useCallback(() => {
    updateMutation.mutate(
      { id: supplierId, data: form },
      { onSuccess: () => setEditing(false) },
    );
  }, [form, supplierId, updateMutation]);

  const handleDeactivate = useCallback(() => {
    updateMutation.mutate({
      id: supplierId,
      data: { is_active: false },
    });
  }, [supplierId, updateMutation]);

  if (isLoading) {
    return (
      <div className="animate-pulse space-y-4 border-l p-4">
        <div className="h-6 w-40 rounded bg-muted" />
        <div className="h-4 w-60 rounded bg-muted" />
        <div className="h-32 rounded bg-muted" />
      </div>
    );
  }

  if (!supplier) return null;

  return (
    <div className="border-l p-4">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold">{supplier.name}</h3>
        <button
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>

      {editing ? (
        <div className="space-y-3">
          {(
            [
              ["name", "Name"],
              ["contact_name", "Contact name"],
              ["email", "Email"],
              ["phone", "Phone"],
              ["website", "Website"],
              ["address", "Address"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs text-muted-foreground">{label}</span>
              <input
                type="text"
                value={(form as any)[key] ?? ""}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className="mt-0.5 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              />
            </label>
          ))}
          <label className="block">
            <span className="text-xs text-muted-foreground">Notes</span>
            <textarea
              value={form.notes ?? ""}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="mt-0.5 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              rows={3}
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={updateMutation.isPending}
              className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {updateMutation.isPending ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-md border px-4 py-1.5 text-sm hover:bg-muted"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <dl className="space-y-2 text-sm">
            {supplier.contact_name && (
              <div>
                <dt className="text-muted-foreground">Contact</dt>
                <dd>{supplier.contact_name}</dd>
              </div>
            )}
            {supplier.email && (
              <div>
                <dt className="text-muted-foreground">Email</dt>
                <dd>{supplier.email}</dd>
              </div>
            )}
            {supplier.phone && (
              <div>
                <dt className="text-muted-foreground">Phone</dt>
                <dd>{supplier.phone}</dd>
              </div>
            )}
            {supplier.website && (
              <div>
                <dt className="text-muted-foreground">Website</dt>
                <dd>
                  <a
                    href={supplier.website}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline"
                  >
                    {supplier.website}
                  </a>
                </dd>
              </div>
            )}
            {supplier.address && (
              <div>
                <dt className="text-muted-foreground">Address</dt>
                <dd>{supplier.address}</dd>
              </div>
            )}
            {supplier.notes && (
              <div>
                <dt className="text-muted-foreground">Notes</dt>
                <dd className="whitespace-pre-wrap">{supplier.notes}</dd>
              </div>
            )}
          </dl>

          <div className="mt-4 flex gap-2">
            <button
              onClick={handleStartEdit}
              className="rounded-md border px-4 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Edit
            </button>
            {supplier.is_active && (
              <button
                onClick={handleDeactivate}
                disabled={updateMutation.isPending}
                className="rounded-md border border-red-200 px-4 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Deactivate
              </button>
            )}
          </div>

          {/* Spend chart (bar) */}
          {supplier.monthly_spend.length > 0 && (
            <div className="mt-6">
              <h4 className="mb-2 text-sm font-medium">
                Monthly spend (last 6 months)
              </h4>
              <div className="flex items-end gap-1" style={{ height: 100 }}>
                {(() => {
                  const max = Math.max(
                    ...supplier.monthly_spend.map((m) => m.amount),
                  );
                  return supplier.monthly_spend.map((m) => (
                    <div
                      key={m.month}
                      className="flex flex-1 flex-col items-center gap-1"
                    >
                      <div
                        className="w-full rounded-t bg-primary/70"
                        style={{
                          height: `${max > 0 ? (m.amount / max) * 80 : 0}px`,
                        }}
                        title={formatAmount(m.amount, "EUR")}
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {m.month.slice(5)}
                      </span>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}

          {/* Recent expenses */}
          {supplier.recent_expenses.length > 0 && (
            <div className="mt-6">
              <h4 className="mb-2 text-sm font-medium">Recent expenses</h4>
              <div className="space-y-1">
                {supplier.recent_expenses.map((exp) => (
                  <div
                    key={exp.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="truncate">{exp.description}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatAmount(exp.amount, "EUR")} ·{" "}
                      {new Date(exp.date).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Open orders */}
          {supplier.open_orders.length > 0 && (
            <div className="mt-6">
              <h4 className="mb-2 text-sm font-medium">Open orders</h4>
              <div className="space-y-1">
                {supplier.open_orders.map((ord) => (
                  <div
                    key={ord.id}
                    className="flex items-center justify-between text-xs"
                  >
                    <span>{ord.reference}</span>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={ord.status} />
                      <span className="text-muted-foreground">
                        {formatAmount(ord.total_amount, "EUR")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New supplier panel
// ---------------------------------------------------------------------------

function NewSupplierPanel({
  businessId,
  onClose,
}: {
  businessId: string;
  onClose: () => void;
}) {
  const createMutation = useCreateSupplier(businessId);
  const [form, setForm] = useState<CreateSupplierData>({
    name: "",
    contact_name: null,
    email: null,
    phone: null,
    website: null,
    address: null,
    notes: null,
  });

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!form.name.trim()) return;
      createMutation.mutate(form, { onSuccess: () => onClose() });
    },
    [form, createMutation, onClose],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="border-l p-4"
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold">New Supplier</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="space-y-3">
        {(
          [
            ["name", "Name *", "text"],
            ["contact_name", "Contact name", "text"],
            ["email", "Email", "email"],
            ["phone", "Phone", "tel"],
            ["website", "Website", "url"],
            ["address", "Address", "text"],
          ] as const
        ).map(([key, label, type]) => (
          <label key={key} className="block">
            <span className="text-xs text-muted-foreground">{label}</span>
            <input
              type={type}
              value={(form as any)[key] ?? ""}
              onChange={(e) =>
                setForm({ ...form, [key]: e.target.value || null })
              }
              className="mt-0.5 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
              required={key === "name"}
            />
          </label>
        ))}
        <label className="block">
          <span className="text-xs text-muted-foreground">Notes</span>
          <textarea
            value={form.notes ?? ""}
            onChange={(e) =>
              setForm({ ...form, notes: e.target.value || null })
            }
            className="mt-0.5 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            rows={3}
          />
        </label>
      </div>

      <button
        type="submit"
        disabled={createMutation.isPending || !form.name.trim()}
        className="mt-4 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {createMutation.isPending ? "Creating…" : "Create Supplier"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Orders tab
// ---------------------------------------------------------------------------

function OrdersTab({
  businessId,
  userId,
  suppliers,
}: {
  businessId: string;
  userId: string;
  suppliers: SupplierWithStats[];
}) {
  const [statusFilter, setStatusFilter] = useState<
    SupplierOrderStatus[] | undefined
  >();
  const [supplierFilter, setSupplierFilter] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [showNew, setShowNew] = useState(false);

  const filters = useMemo(
    () => ({
      supplierId: supplierFilter,
      status: statusFilter,
      page,
      limit: 25,
    }),
    [supplierFilter, statusFilter, page],
  );

  const { data: orderData, isLoading } = useSupplierOrders(
    businessId,
    filters,
  );
  const updateStatusMutation = useUpdateOrderStatus(businessId);

  const handleStatusChange = useCallback(
    (orderId: string, newStatus: SupplierOrderStatus) => {
      updateStatusMutation.mutate({ orderId, status: newStatus });
    },
    [updateStatusMutation],
  );

  return (
    <div className="space-y-4 p-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={supplierFilter ?? ""}
          onChange={(e) => {
            setSupplierFilter(e.target.value || undefined);
            setPage(1);
          }}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
        >
          <option value="">All suppliers</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <select
          value={statusFilter?.join(",") ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            setStatusFilter(
              val
                ? (val.split(",") as SupplierOrderStatus[])
                : undefined,
            );
            setPage(1);
          }}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="ordered">Ordered</option>
          <option value="received">Received</option>
          <option value="cancelled">Cancelled</option>
        </select>

        <button
          onClick={() => setShowNew(true)}
          className="ml-auto rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          + New Order
        </button>
      </div>

      {/* New order form */}
      {showNew && (
        <NewOrderForm
          businessId={businessId}
          userId={userId}
          suppliers={suppliers}
          onClose={() => setShowNew(false)}
        />
      )}

      {/* Order list */}
      {isLoading ? (
        <div className="animate-pulse space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-lg bg-muted" />
          ))}
        </div>
      ) : orderData?.orders.length === 0 ? (
        <EmptyState
          icon="📦"
          title="No orders found"
          description="No orders match your current filters. Create a new order to get started."
        />
      ) : (
        <>
          <div className="space-y-2">
            {orderData?.orders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onStatusChange={handleStatusChange}
              />
            ))}
          </div>

          {orderData && orderData.total > 25 && (
            <div className="flex items-center justify-between text-sm">
              <p className="text-muted-foreground">{orderData.total} total</p>
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
                  disabled={page * 25 >= orderData.total}
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
  );
}

// ---------------------------------------------------------------------------
// Order card
// ---------------------------------------------------------------------------

function OrderCard({
  order,
  onStatusChange,
}: {
  order: SupplierOrderRow;
  onStatusChange: (orderId: string, status: SupplierOrderStatus) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{order.reference}</p>
            <StatusBadge status={order.status} />
          </div>
          <p className="text-xs text-muted-foreground">
            {order.supplier?.name ?? "Unknown supplier"} ·{" "}
            {formatAmount(order.total_amount, "EUR")}
            {order.ordered_at &&
              ` · Ordered ${new Date(order.ordered_at).toLocaleDateString()}`}
            {order.expected_at &&
              ` · Expected ${new Date(order.expected_at).toLocaleDateString()}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {order.status === "draft" && (
            <button
              onClick={() => onStatusChange(order.id, "ordered")}
              className="rounded border px-2 py-1 text-xs hover:bg-muted"
            >
              Mark Ordered
            </button>
          )}
          {order.status === "ordered" && (
            <button
              onClick={() => onStatusChange(order.id, "received")}
              className="rounded border px-2 py-1 text-xs hover:bg-muted"
            >
              Mark Received
            </button>
          )}
          {(order.status === "draft" || order.status === "ordered") && (
            <button
              onClick={() => onStatusChange(order.id, "cancelled")}
              className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
            >
              Cancel
            </button>
          )}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? "Hide items" : `${order.items.length} items`}
          </button>
        </div>
      </div>

      {expanded && order.items.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-1">Product</th>
                <th className="pb-1">SKU</th>
                <th className="pb-1 text-right">Qty</th>
                <th className="pb-1 text-right">Unit price</th>
                <th className="pb-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {order.items.map((item) => (
                <tr key={item.id}>
                  <td className="py-0.5">{item.product_name}</td>
                  <td className="py-0.5 text-muted-foreground">
                    {item.sku ?? "—"}
                  </td>
                  <td className="py-0.5 text-right">{item.quantity}</td>
                  <td className="py-0.5 text-right">
                    {formatAmount(item.unit_price, "EUR")}
                  </td>
                  <td className="py-0.5 text-right">
                    {formatAmount(item.total_price, "EUR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {order.notes && (
            <p className="mt-2 text-xs text-muted-foreground">
              Notes: {order.notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New order form
// ---------------------------------------------------------------------------

function NewOrderForm({
  businessId,
  userId,
  suppliers,
  onClose,
}: {
  businessId: string;
  userId: string;
  suppliers: SupplierWithStats[];
  onClose: () => void;
}) {
  const createMutation = useCreateSupplierOrder(businessId, userId);
  const [form, setForm] = useState({
    supplier_id: "",
    reference: "",
    notes: "",
    ordered_at: "",
    expected_at: "",
  });
  const [items, setItems] = useState<CreateOrderItemData[]>([
    { product_name: "", quantity: 1, unit_price: 0 },
  ]);

  const total = items.reduce(
    (sum, item) => sum + item.quantity * item.unit_price,
    0,
  );

  const addItem = useCallback(() => {
    setItems((prev) => [
      ...prev,
      { product_name: "", quantity: 1, unit_price: 0 },
    ]);
  }, []);

  const removeItem = useCallback((index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateItem = useCallback(
    (index: number, field: keyof CreateOrderItemData, value: string | number) => {
      setItems((prev) =>
        prev.map((item, i) =>
          i === index ? { ...item, [field]: value } : item,
        ),
      );
    },
    [],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!form.supplier_id || !form.reference.trim() || items.length === 0)
        return;

      const data: CreateOrderData = {
        supplier_id: form.supplier_id,
        reference: form.reference,
        notes: form.notes || null,
        ordered_at: form.ordered_at || null,
        expected_at: form.expected_at || null,
        items: items.filter((i) => i.product_name.trim()),
      };
      createMutation.mutate(data, { onSuccess: () => onClose() });
    },
    [form, items, createMutation, onClose],
  );

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border bg-card p-4 shadow-sm"
    >
      <div className="mb-4 flex items-center justify-between">
        <h4 className="text-sm font-semibold">New Order</h4>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs text-muted-foreground">Supplier *</span>
          <select
            value={form.supplier_id}
            onChange={(e) =>
              setForm({ ...form, supplier_id: e.target.value })
            }
            className="mt-0.5 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            required
          >
            <option value="">Select supplier…</option>
            {suppliers
              .filter((s) => s.is_active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Reference *</span>
          <input
            type="text"
            value={form.reference}
            onChange={(e) =>
              setForm({ ...form, reference: e.target.value })
            }
            className="mt-0.5 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
            required
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Order date</span>
          <input
            type="date"
            value={form.ordered_at}
            onChange={(e) =>
              setForm({ ...form, ordered_at: e.target.value })
            }
            className="mt-0.5 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs text-muted-foreground">Expected date</span>
          <input
            type="date"
            value={form.expected_at}
            onChange={(e) =>
              setForm({ ...form, expected_at: e.target.value })
            }
            className="mt-0.5 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </label>
      </div>

      <label className="mt-3 block">
        <span className="text-xs text-muted-foreground">Notes</span>
        <textarea
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          className="mt-0.5 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          rows={2}
        />
      </label>

      {/* Items */}
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium">Items</span>
          <button
            type="button"
            onClick={addItem}
            className="text-xs text-primary hover:underline"
          >
            + Add item
          </button>
        </div>
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex items-end gap-2">
              <label className="flex-1">
                <span className="text-[10px] text-muted-foreground">
                  Product
                </span>
                <input
                  type="text"
                  value={item.product_name}
                  onChange={(e) =>
                    updateItem(i, "product_name", e.target.value)
                  }
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                  required
                />
              </label>
              <label className="w-16">
                <span className="text-[10px] text-muted-foreground">Qty</span>
                <input
                  type="number"
                  min={1}
                  value={item.quantity}
                  onChange={(e) =>
                    updateItem(i, "quantity", parseInt(e.target.value) || 1)
                  }
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                />
              </label>
              <label className="w-24">
                <span className="text-[10px] text-muted-foreground">
                  Unit price
                </span>
                <input
                  type="number"
                  min={0}
                  step={0.01}
                  value={item.unit_price}
                  onChange={(e) =>
                    updateItem(
                      i,
                      "unit_price",
                      parseFloat(e.target.value) || 0,
                    )
                  }
                  className="w-full rounded-md border bg-background px-2 py-1 text-sm"
                />
              </label>
              <span className="pb-1 text-xs text-muted-foreground">
                {formatAmount(item.quantity * item.unit_price, "EUR")}
              </span>
              {items.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeItem(i)}
                  className="pb-1 text-xs text-red-500 hover:text-red-700"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="mt-2 text-right text-sm font-medium">
          Total: {formatAmount(total, "EUR")}
        </p>
      </div>

      <button
        type="submit"
        disabled={
          createMutation.isPending ||
          !form.supplier_id ||
          !form.reference.trim()
        }
        className="mt-4 w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {createMutation.isPending ? "Creating…" : "Create Order"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type Tab = "suppliers" | "orders";

export default function SuppliersPage() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId ?? "";
  const userId = user?.id ?? "";

  const [tab, setTab] = useState<Tab>("suppliers");
  const [searchInput, setSearchInput] = useState("");
  const [showActive, setShowActive] = useState(true);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNewPanel, setShowNewPanel] = useState(false);

  const filters: SupplierFilters = useMemo(
    () => ({ isActive: showActive ? true : undefined, page, limit: 25 }),
    [showActive, page],
  );

  const { data: supplierData, isLoading } = useSuppliers(
    businessId,
    filters,
    searchInput,
  );

  const totalSpent = useMemo(
    () =>
      supplierData?.suppliers.reduce((s, sup) => s + sup.total_spent, 0) ?? 0,
    [supplierData],
  );
  const totalOpenOrders = useMemo(
    () =>
      supplierData?.suppliers.reduce((s, sup) => s + sup.open_orders, 0) ?? 0,
    [supplierData],
  );

  if (!businessId) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* ── KPI row ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <StatCard
          label="Total suppliers"
          value={supplierData?.total ?? "—"}
        />
        <StatCard
          label="Total spent"
          value={formatAmount(totalSpent, "EUR")}
        />
        <StatCard label="Open orders" value={totalOpenOrders} />
        <StatCard
          label="Active"
          value={
            supplierData?.suppliers.filter((s) => s.is_active).length ?? "—"
          }
        />
      </div>

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 border-b px-4">
        {(["suppliers", "orders"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-4 py-2 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* ── Tab content ──────────────────────────────────────── */}
      {tab === "suppliers" && (
        <div className="flex flex-1 overflow-hidden">
          {/* Supplier list */}
          <div className="flex-1 overflow-auto">
            {/* Toolbar */}
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <input
                type="text"
                placeholder="Search suppliers…"
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setPage(1);
                }}
                className="w-72 rounded-md border bg-background px-3 py-1.5 text-sm"
              />

              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={showActive}
                  onChange={(e) => {
                    setShowActive(e.target.checked);
                    setPage(1);
                  }}
                  className="rounded"
                />
                Active only
              </label>

              <button
                onClick={() => {
                  setShowNewPanel(true);
                  setSelectedId(null);
                }}
                className="ml-auto rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                + New Supplier
              </button>
            </div>

            {/* List */}
            <div className="px-4 pb-4">
              {isLoading ? (
                <div className="animate-pulse space-y-2">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-16 rounded-lg bg-muted" />
                  ))}
                </div>
              ) : supplierData?.suppliers.length === 0 ? (
                <EmptyState
                  icon="📦"
                  title="No suppliers found"
                  description="No suppliers match your search. Add a new supplier to track your spending."
                />
              ) : (
                <>
                  <div className="space-y-2">
                    {supplierData?.suppliers.map((supplier) => (
                      <SupplierRow
                        key={supplier.id}
                        supplier={supplier}
                        selected={selectedId === supplier.id}
                        onSelect={() => {
                          setSelectedId(supplier.id);
                          setShowNewPanel(false);
                        }}
                      />
                    ))}
                  </div>

                  {supplierData && supplierData.total > 25 && (
                    <div className="mt-4 flex items-center justify-between text-sm">
                      <p className="text-muted-foreground">
                        {supplierData.total} total
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
                          disabled={page * 25 >= supplierData.total}
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
          </div>

          {/* Side panel */}
          {selectedId && !showNewPanel && (
            <div className="w-96 shrink-0 overflow-auto">
              <SupplierDetailPanel
                supplierId={selectedId}
                businessId={businessId}
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
          {showNewPanel && (
            <div className="w-96 shrink-0 overflow-auto">
              <NewSupplierPanel
                businessId={businessId}
                onClose={() => setShowNewPanel(false)}
              />
            </div>
          )}
        </div>
      )}

      {tab === "orders" && (
        <OrdersTab
          businessId={businessId}
          userId={userId}
          suppliers={supplierData?.suppliers ?? []}
        />
      )}
    </div>
  );
}
