import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../lib/supabase";
import { useAuth } from "./useAuth";
import { NetworkError } from "../types/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Notification {
  id: string;
  business_id: string | null;
  user_id: string | null;
  type: string;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  is_read: boolean;
  created_at: string;
}

const NOTIFICATIONS_KEY = "notifications";

// ---------------------------------------------------------------------------
// useNotifications — useQuery + Realtime subscription
// ---------------------------------------------------------------------------

export function useNotifications(limit = 50) {
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();

  // Realtime subscription: invalidate on any INSERT to notifications for this user
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`notifications:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: [NOTIFICATIONS_KEY, userId] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);

  return useQuery<Notification[]>({
    queryKey: [NOTIFICATIONS_KEY, userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", userId!)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) throw new NetworkError(error.message, 500);
      return (data ?? []) as Notification[];
    },
    enabled: !!userId,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// useNotificationCount — derived unread count
// ---------------------------------------------------------------------------

export function useNotificationCount() {
  const { data: notifications } = useNotifications();

  return useMemo(
    () => (notifications ?? []).filter((n: Notification) => !n.is_read).length,
    [notifications],
  );
}

// ---------------------------------------------------------------------------
// useMarkNotificationRead — mark single notification as read
// ---------------------------------------------------------------------------

export function useMarkNotificationRead() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("id", id);

      if (error) throw new NetworkError(error.message, 500);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [NOTIFICATIONS_KEY, user?.id],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// useMarkAllRead — mark all notifications as read
// ---------------------------------------------------------------------------

export function useMarkAllRead() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation<void, Error, void>({
    mutationFn: async () => {
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true })
        .eq("user_id", user!.id)
        .eq("is_read", false);

      if (error) throw new NetworkError(error.message, 500);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [NOTIFICATIONS_KEY, user?.id],
      });
    },
  });
}
