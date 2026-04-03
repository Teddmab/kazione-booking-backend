import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getClients,
  getClient,
  createClient,
  updateClient,
  updateClientNotes,
  importClients,
} from "../services/clientService";
import type { ClientDetailWithAppointments } from "../services/clientService";
import type {
  ClientDetail,
  ClientFilters,
  ClientWithStats,
  CreateClientData,
  ImportResult,
  ImportRow,
  PaginatedClients,
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
// Client list with debounced search
// ---------------------------------------------------------------------------

export function useClients(
  businessId: string,
  filters: ClientFilters = {},
  searchInput = "",
) {
  const debouncedSearch = useDebounce(searchInput, 300);

  const mergedFilters: ClientFilters = useMemo(
    () => ({
      ...filters,
      search: debouncedSearch || undefined,
    }),
    [filters, debouncedSearch],
  );

  return useQuery<PaginatedClients>({
    queryKey: ["clients", businessId, mergedFilters],
    queryFn: () => getClients(businessId, mergedFilters),
    enabled: !!businessId,
  });
}

// ---------------------------------------------------------------------------
// Single client detail
// ---------------------------------------------------------------------------

export function useClient(id: string | null) {
  return useQuery<ClientDetailWithAppointments>({
    queryKey: ["client", id],
    queryFn: () => getClient(id!),
    enabled: !!id,
  });
}

// ---------------------------------------------------------------------------
// Create client
// ---------------------------------------------------------------------------

export function useCreateClient(businessId: string) {
  const queryClient = useQueryClient();
  return useMutation<ClientDetail, Error, CreateClientData>({
    mutationFn: (data) => createClient(businessId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Update client
// ---------------------------------------------------------------------------

export function useUpdateClient() {
  const queryClient = useQueryClient();
  return useMutation<
    ClientDetail,
    Error,
    { id: string; data: Partial<CreateClientData> }
  >({
    mutationFn: ({ id, data }) => updateClient(id, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["client", variables.id] });
    },
  });
}

// ---------------------------------------------------------------------------
// Update client notes
// ---------------------------------------------------------------------------

export function useUpdateClientNotes() {
  const queryClient = useQueryClient();
  return useMutation<ClientDetail, Error, { id: string; notes: string }>({
    mutationFn: ({ id, notes }) => updateClientNotes(id, notes),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
      queryClient.invalidateQueries({ queryKey: ["client", variables.id] });
    },
  });
}

// ---------------------------------------------------------------------------
// Import clients
// ---------------------------------------------------------------------------

export function useImportClients(businessId: string) {
  const queryClient = useQueryClient();
  return useMutation<ImportResult, Error, ImportRow[]>({
    mutationFn: (rows) => importClients(businessId, rows),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["clients"] });
    },
  });
}
