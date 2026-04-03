import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import type { User, Session } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    session: null,
    loading: true,
  });

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setState({ user: session?.user ?? null, session, loading: false });
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setState({ user: session?.user ?? null, session, loading: false });
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = () => supabase.auth.signOut();

  return { ...state, signOut };
}

// ---------------------------------------------------------------------------
// User profile (from public.users table)
// ---------------------------------------------------------------------------

export interface UserProfile {
  id: string;
  full_name: string;
  avatar_url: string | null;
  email: string;
}

export function useUserProfile(userId: string | undefined) {
  return useQuery<UserProfile>({
    queryKey: ["user-profile", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, avatar_url, email")
        .eq("id", userId!)
        .single();
      if (error) throw error;
      return data as UserProfile;
    },
    enabled: !!userId,
    staleTime: 300_000,
  });
}

// ---------------------------------------------------------------------------
// Tenant context (business + role)
// ---------------------------------------------------------------------------

export type MemberRole = "owner" | "manager" | "staff" | "receptionist";

export interface TenantContext {
  businessId: string;
  businessName: string;
  role: MemberRole;
}

export function useTenant(userId: string | undefined) {
  return useQuery<TenantContext>({
    queryKey: ["tenant", userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("business_members")
        .select("business_id, role, businesses(name)")
        .eq("user_id", userId!)
        .eq("is_active", true)
        .limit(1)
        .single();
      if (error) throw error;
      const biz = data.businesses as unknown as { name: string };
      return {
        businessId: data.business_id,
        businessName: biz.name,
        role: data.role as MemberRole,
      };
    },
    enabled: !!userId,
    staleTime: 300_000,
  });
}
