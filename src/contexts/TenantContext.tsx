import {
  createContext,
  useContext,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAuthContext } from "./AuthContext";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberRole = "owner" | "manager" | "staff" | "receptionist";

export interface TenantContextValue {
  businessId: string;
  businessName: string;
  role: MemberRole;
}

interface TenantState {
  tenant: TenantContextValue | null;
  loading: boolean;
  error: Error | null;
}

const TenantContext = createContext<TenantState | undefined>(undefined);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function TenantProvider({ children }: { children: ReactNode }) {
  const { user } = useAuthContext();

  const { data, isLoading, error } = useQuery<TenantContextValue>({
    queryKey: ["tenant", user?.id],
    queryFn: async () => {
      const { data: row, error: err } = await supabase
        .from("business_members")
        .select("business_id, role, businesses(name)")
        .eq("user_id", user!.id)
        .eq("is_active", true)
        .limit(1)
        .single();
      if (err) throw err;
      const biz = row.businesses as unknown as { name: string };
      return {
        businessId: row.business_id,
        businessName: biz.name,
        role: row.role as MemberRole,
      };
    },
    enabled: !!user?.id,
    staleTime: 300_000,
    retry: false,
  });

  return (
    <TenantContext.Provider
      value={{
        tenant: data ?? null,
        loading: isLoading && !!user?.id,
        error: error as Error | null,
      }}
    >
      {children}
    </TenantContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useTenantContext() {
  const ctx = useContext(TenantContext);
  if (!ctx) throw new Error("useTenantContext must be used within TenantProvider");
  return ctx;
}
