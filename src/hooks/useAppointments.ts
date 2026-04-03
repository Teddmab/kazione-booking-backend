import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAppointments,
  getAppointment,
  createAppointment,
  updateAppointmentStatus,
  getDashboardKPIs,
  getCalendar,
} from "../services/appointmentService";
import type {
  AppointmentDetail,
  AppointmentFilters,
  AppointmentStatus,
  AppointmentWithRelations,
  CalendarEntry,
  CreateAppointmentData,
  DashboardKPIs,
  PaginatedAppointments,
} from "../types/api";

// ---------------------------------------------------------------------------
// List with filters
// ---------------------------------------------------------------------------

export function useAppointments(
  businessId: string,
  filters: AppointmentFilters = {},
) {
  return useQuery<PaginatedAppointments>({
    queryKey: ["appointments", businessId, filters],
    queryFn: () => getAppointments(businessId, filters),
    enabled: !!businessId,
  });
}

// ---------------------------------------------------------------------------
// Single appointment detail
// ---------------------------------------------------------------------------

export function useAppointment(id: string) {
  return useQuery<AppointmentDetail>({
    queryKey: ["appointment", id],
    queryFn: () => getAppointment(id),
    enabled: !!id,
  });
}

// ---------------------------------------------------------------------------
// Create appointment (manual booking)
// ---------------------------------------------------------------------------

export function useCreateAppointment(businessId: string) {
  const queryClient = useQueryClient();
  return useMutation<AppointmentWithRelations, Error, CreateAppointmentData>({
    mutationFn: (data) => createAppointment(businessId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-kpis"] });
      queryClient.invalidateQueries({ queryKey: ["calendar"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Update appointment status
// ---------------------------------------------------------------------------

export function useUpdateAppointmentStatus() {
  const queryClient = useQueryClient();
  return useMutation<
    AppointmentWithRelations,
    Error,
    { id: string; status: AppointmentStatus; reason?: string; changedBy?: string }
  >({
    mutationFn: ({ id, status, reason, changedBy }) =>
      updateAppointmentStatus(id, status, reason, changedBy),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      queryClient.invalidateQueries({ queryKey: ["appointment", variables.id] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-kpis"] });
      queryClient.invalidateQueries({ queryKey: ["calendar"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Dashboard KPIs
// ---------------------------------------------------------------------------

export function useDashboardKPIs(businessId: string) {
  return useQuery<DashboardKPIs>({
    queryKey: ["dashboard-kpis", businessId],
    queryFn: () => getDashboardKPIs(businessId),
    enabled: !!businessId,
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Calendar view
// ---------------------------------------------------------------------------

export function useCalendar(
  businessId: string,
  startDate: string,
  endDate: string,
  staffId?: string,
) {
  return useQuery<CalendarEntry[]>({
    queryKey: ["calendar", businessId, startDate, endDate, staffId],
    queryFn: () => getCalendar(businessId, startDate, endDate, staffId),
    enabled: !!businessId && !!startDate && !!endDate,
  });
}
