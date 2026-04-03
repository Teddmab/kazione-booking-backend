import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import {
  getCustomerBookings,
  lookupBookingByReference,
  cancelBooking,
  rescheduleBooking,
} from "../services/bookingService";
import type {
  AppointmentWithRelations,
  LookupBookingResult,
  CancelBookingParams,
  RescheduleBookingParams,
  RescheduleBookingResult,
} from "../types/api";

// ---------------------------------------------------------------------------
// Authenticated user's bookings
// ---------------------------------------------------------------------------

export function useCustomerBookings() {
  return useQuery<AppointmentWithRelations[]>({
    queryKey: ["customer-bookings"],
    queryFn: async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return [];
      return getCustomerBookings(user.id);
    },
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Guest lookup by email + reference
// ---------------------------------------------------------------------------

export function useLookupBooking(email: string, reference: string) {
  return useQuery<LookupBookingResult>({
    queryKey: ["lookup-booking", email, reference],
    queryFn: () => lookupBookingByReference(email, reference),
    enabled: !!email && !!reference,
    staleTime: 30_000,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Cancel mutation
// ---------------------------------------------------------------------------

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation<{ refundAmount: number }, Error, CancelBookingParams>({
    mutationFn: cancelBooking,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-bookings"] });
      queryClient.invalidateQueries({ queryKey: ["lookup-booking"] });
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Reschedule mutation
// ---------------------------------------------------------------------------

export function useRescheduleBooking() {
  const queryClient = useQueryClient();
  return useMutation<RescheduleBookingResult, Error, RescheduleBookingParams>({
    mutationFn: rescheduleBooking,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customer-bookings"] });
      queryClient.invalidateQueries({ queryKey: ["lookup-booking"] });
      queryClient.invalidateQueries({ queryKey: ["appointments"] });
      queryClient.invalidateQueries({ queryKey: ["availability"] });
    },
  });
}
