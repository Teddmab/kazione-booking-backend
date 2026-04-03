import { useQuery } from "@tanstack/react-query";
import { getStorefront } from "../services/bookingService";
import type { StorefrontData } from "../types/api";

export function useStorefront(slug: string) {
  return useQuery<StorefrontData>({
    queryKey: ["storefront", slug],
    queryFn: () => getStorefront(slug),
    enabled: !!slug,
    staleTime: 60_000,
  });
}
