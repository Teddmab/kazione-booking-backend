import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  getSupplierOrders,
  createSupplierOrder,
  updateOrderStatus,
} from "../services/supplierService";
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
} from "../types/api";

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function useDebounce(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useMemo(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// useSuppliers — paginated list with debounced search
// ---------------------------------------------------------------------------

export function useSuppliers(
  businessId: string,
  filters: SupplierFilters = {},
  searchInput = "",
) {
  const debouncedSearch = useDebounce(searchInput, 300);

  const mergedFilters: SupplierFilters = useMemo(
    () => ({
      ...filters,
      search: debouncedSearch || undefined,
    }),
    [filters, debouncedSearch],
  );

  return useQuery<PaginatedSuppliers>({
    queryKey: ["suppliers", businessId, mergedFilters],
    queryFn: () => getSuppliers(businessId, mergedFilters),
    enabled: !!businessId,
  });
}

// ---------------------------------------------------------------------------
// useSupplier — single supplier detail
// ---------------------------------------------------------------------------

export function useSupplier(id: string | null) {
  return useQuery<SupplierDetail>({
    queryKey: ["supplier", id],
    queryFn: () => getSupplier(id!),
    enabled: !!id,
  });
}

// ---------------------------------------------------------------------------
// useCreateSupplier
// ---------------------------------------------------------------------------

export function useCreateSupplier(businessId: string) {
  const queryClient = useQueryClient();
  return useMutation<SupplierRow, Error, CreateSupplierData>({
    mutationFn: (data) => createSupplier(businessId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["suppliers", businessId] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateSupplier
// ---------------------------------------------------------------------------

export function useUpdateSupplier(businessId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    SupplierRow,
    Error,
    { id: string; data: Partial<CreateSupplierData> & { is_active?: boolean } }
  >({
    mutationFn: ({ id, data }) => updateSupplier(id, data),
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["suppliers", businessId] });
      queryClient.invalidateQueries({
        queryKey: ["supplier", variables.id],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// useSupplierOrders — paginated orders with filters
// ---------------------------------------------------------------------------

export function useSupplierOrders(
  businessId: string,
  filters: SupplierOrderFilters = {},
) {
  return useQuery<PaginatedSupplierOrders>({
    queryKey: ["supplier-orders", businessId, filters],
    queryFn: () => getSupplierOrders(businessId, filters),
    enabled: !!businessId,
  });
}

// ---------------------------------------------------------------------------
// useCreateSupplierOrder
// ---------------------------------------------------------------------------

export function useCreateSupplierOrder(businessId: string, userId: string) {
  const queryClient = useQueryClient();
  return useMutation<SupplierOrderRow, Error, CreateOrderData>({
    mutationFn: (data) => createSupplierOrder(businessId, userId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["supplier-orders", businessId],
      });
      queryClient.invalidateQueries({ queryKey: ["suppliers", businessId] });
    },
  });
}

// ---------------------------------------------------------------------------
// useUpdateOrderStatus
// ---------------------------------------------------------------------------

export function useUpdateOrderStatus(businessId: string) {
  const queryClient = useQueryClient();
  return useMutation<
    SupplierOrderRow,
    Error,
    { orderId: string; status: SupplierOrderStatus }
  >({
    mutationFn: ({ orderId, status }) => updateOrderStatus(orderId, status),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["supplier-orders", businessId],
      });
      queryClient.invalidateQueries({ queryKey: ["suppliers", businessId] });
    },
  });
}
