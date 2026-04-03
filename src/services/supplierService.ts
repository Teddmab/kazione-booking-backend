import { supabase } from "../lib/supabase";
import { NetworkError } from "../types/api";
import type {
  CreateOrderData,
  CreateSupplierData,
  PaginatedSupplierOrders,
  PaginatedSuppliers,
  SupplierDetail,
  SupplierFilters,
  SupplierOrderFilters,
  SupplierOrderRow,
  SupplierOrderStatus,
  SupplierRow,
  SupplierWithStats,
} from "../types/api";

// ---------------------------------------------------------------------------
// getSuppliers — paginated list with total_spent + open_orders aggregation
// ---------------------------------------------------------------------------

export async function getSuppliers(
  businessId: string,
  filters: SupplierFilters = {},
): Promise<PaginatedSuppliers> {
  const { search, isActive, page = 1, limit = 25 } = filters;

  let query = supabase
    .from("suppliers")
    .select(
      `
      *,
      expenses:expenses(amount),
      orders:supplier_orders(id, status)
    `,
      { count: "exact" },
    )
    .eq("business_id", businessId)
    .order("name", { ascending: true });

  if (search) {
    query = query.or(
      `name.ilike.%${search}%,contact_name.ilike.%${search}%,email.ilike.%${search}%`,
    );
  }

  if (isActive !== undefined) {
    query = query.eq("is_active", isActive);
  }

  const from = (page - 1) * limit;
  query = query.range(from, from + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new NetworkError(error.message, 500);

  const suppliers: SupplierWithStats[] = (data ?? []).map((row: any) => {
    const expenses = (row.expenses ?? []) as { amount: number }[];
    const orders = (row.orders ?? []) as { id: string; status: string }[];

    const total_spent = expenses.reduce((sum, e) => sum + e.amount, 0);
    const open_orders = orders.filter(
      (o) => o.status === "draft" || o.status === "ordered",
    ).length;

    const { expenses: _e, orders: _o, ...supplier } = row;
    return { ...supplier, total_spent, open_orders } as SupplierWithStats;
  });

  return { suppliers, total: count ?? 0 };
}

// ---------------------------------------------------------------------------
// getSupplier — single supplier with recent expenses, open orders, 6-mo spend
// ---------------------------------------------------------------------------

export async function getSupplier(id: string): Promise<SupplierDetail> {
  const { data, error } = await supabase
    .from("suppliers")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new NetworkError(error.message, 404);

  const supplier = data as SupplierRow;

  // Last 10 expenses for this supplier
  const { data: expRows } = await supabase
    .from("expenses")
    .select("id, description, amount, date, category")
    .eq("supplier_id", id)
    .order("date", { ascending: false })
    .limit(10);

  // Open orders (draft / ordered)
  const { data: orderRows } = await supabase
    .from("supplier_orders")
    .select("id, reference, status, total_amount, ordered_at, expected_at")
    .eq("supplier_id", id)
    .in("status", ["draft", "ordered"])
    .order("created_at", { ascending: false });

  // 6-month spend breakdown
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const { data: spendRows } = await supabase
    .from("expenses")
    .select("amount, date")
    .eq("supplier_id", id)
    .gte("date", sixMonthsAgo.toISOString().slice(0, 10));

  const monthlyMap = new Map<string, number>();
  for (const row of spendRows ?? []) {
    const month = (row as { date: string }).date.slice(0, 7); // YYYY-MM
    monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + (row as any).amount);
  }
  const monthly_spend = Array.from(monthlyMap.entries())
    .map(([month, amount]) => ({ month, amount }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    ...supplier,
    recent_expenses: (expRows ?? []) as SupplierDetail["recent_expenses"],
    open_orders: (orderRows ?? []) as SupplierDetail["open_orders"],
    monthly_spend,
  };
}

// ---------------------------------------------------------------------------
// createSupplier
// ---------------------------------------------------------------------------

export async function createSupplier(
  businessId: string,
  input: CreateSupplierData,
): Promise<SupplierRow> {
  const { data, error } = await supabase
    .from("suppliers")
    .insert({ ...input, business_id: businessId })
    .select()
    .single();
  if (error) throw new NetworkError(error.message, 500);
  return data as SupplierRow;
}

// ---------------------------------------------------------------------------
// updateSupplier
// ---------------------------------------------------------------------------

export async function updateSupplier(
  id: string,
  input: Partial<CreateSupplierData> & { is_active?: boolean },
): Promise<SupplierRow> {
  const { data, error } = await supabase
    .from("suppliers")
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new NetworkError(error.message, 500);
  return data as SupplierRow;
}

// ---------------------------------------------------------------------------
// deactivateSupplier — soft-delete
// ---------------------------------------------------------------------------

export async function deactivateSupplier(id: string): Promise<void> {
  const { error } = await supabase
    .from("suppliers")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new NetworkError(error.message, 500);
}

// ---------------------------------------------------------------------------
// getSupplierOrders — paginated, with items + supplier name
// ---------------------------------------------------------------------------

export async function getSupplierOrders(
  businessId: string,
  filters: SupplierOrderFilters = {},
): Promise<PaginatedSupplierOrders> {
  const { supplierId, status, page = 1, limit = 25 } = filters;

  let query = supabase
    .from("supplier_orders")
    .select(
      `
      *,
      items:supplier_order_items(*),
      supplier:suppliers(name)
    `,
      { count: "exact" },
    )
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });

  if (supplierId) {
    query = query.eq("supplier_id", supplierId);
  }

  if (status?.length) {
    query = query.in("status", status);
  }

  const from = (page - 1) * limit;
  query = query.range(from, from + limit - 1);

  const { data, error, count } = await query;
  if (error) throw new NetworkError(error.message, 500);

  return {
    orders: (data ?? []) as SupplierOrderRow[],
    total: count ?? 0,
  };
}

// ---------------------------------------------------------------------------
// createSupplierOrder — insert order + items, compute total
// ---------------------------------------------------------------------------

export async function createSupplierOrder(
  businessId: string,
  userId: string,
  input: CreateOrderData,
): Promise<SupplierOrderRow> {
  const total_amount = input.items.reduce(
    (sum, item) => sum + item.quantity * item.unit_price,
    0,
  );

  const { data: order, error: orderErr } = await supabase
    .from("supplier_orders")
    .insert({
      business_id: businessId,
      supplier_id: input.supplier_id,
      reference: input.reference,
      notes: input.notes ?? null,
      ordered_at: input.ordered_at ?? null,
      expected_at: input.expected_at ?? null,
      total_amount,
      created_by: userId,
    })
    .select()
    .single();
  if (orderErr) throw new NetworkError(orderErr.message, 500);

  const items = input.items.map((item) => ({
    order_id: (order as any).id,
    product_name: item.product_name,
    sku: item.sku ?? null,
    quantity: item.quantity,
    unit_price: item.unit_price,
    total_price: item.quantity * item.unit_price,
  }));

  const { error: itemsErr } = await supabase
    .from("supplier_order_items")
    .insert(items);
  if (itemsErr) throw new NetworkError(itemsErr.message, 500);

  // Re-fetch full order with items + supplier
  const { data: full, error: fetchErr } = await supabase
    .from("supplier_orders")
    .select(
      `
      *,
      items:supplier_order_items(*),
      supplier:suppliers(name)
    `,
    )
    .eq("id", (order as any).id)
    .single();
  if (fetchErr) throw new NetworkError(fetchErr.message, 500);

  return full as SupplierOrderRow;
}

// ---------------------------------------------------------------------------
// updateOrderStatus — set received_at when status = 'received'
// ---------------------------------------------------------------------------

export async function updateOrderStatus(
  orderId: string,
  status: SupplierOrderStatus,
): Promise<SupplierOrderRow> {
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
  };

  if (status === "received") {
    update.received_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from("supplier_orders")
    .update(update)
    .eq("id", orderId)
    .select(
      `
      *,
      items:supplier_order_items(*),
      supplier:suppliers(name)
    `,
    )
    .single();
  if (error) throw new NetworkError(error.message, 500);
  return data as SupplierOrderRow;
}
