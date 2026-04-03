import { useQuery } from "@tanstack/react-query";
import { getAvailability } from "../services/bookingService";
import type { AvailabilityParams, AvailabilityResult } from "../types/api";

export function useAvailability(params: Partial<AvailabilityParams>) {
  return useQuery<AvailabilityResult>({
    queryKey: ["availability", params],
    queryFn: () =>
      getAvailability(params as AvailabilityParams),
    enabled:
      !!params.business_id && !!params.service_id && !!params.date,
    staleTime: 30_000,
  });
}
