import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth, useTenant } from "../../hooks/useAuth";
import {
  useNotifications,
  useNotificationCount,
  useMarkNotificationRead,
  useMarkAllRead,
} from "../../hooks/useNotifications";
import type { Notification } from "../../hooks/useNotifications";

// ---------------------------------------------------------------------------
// Time-ago helper
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffSec = Math.floor((now - then) / 1000);

  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Notification type → icon + color
// ---------------------------------------------------------------------------

function notifIcon(type: string): { emoji: string; color: string } {
  switch (type) {
    case "ai_insight":
      return { emoji: "🤖", color: "bg-purple-100 text-purple-700" };
    case "ai_finance":
      return { emoji: "💰", color: "bg-emerald-100 text-emerald-700" };
    case "no_show":
      return { emoji: "⚠️", color: "bg-red-100 text-red-700" };
    case "booking_confirmation":
      return { emoji: "✅", color: "bg-green-100 text-green-700" };
    case "booking_cancellation":
      return { emoji: "❌", color: "bg-red-100 text-red-700" };
    default:
      return { emoji: "🔔", color: "bg-blue-100 text-blue-700" };
  }
}

// ---------------------------------------------------------------------------
// Notification item
// ---------------------------------------------------------------------------

function NotificationItem({
  notification,
  onRead,
}: {
  notification: Notification;
  onRead: (id: string) => void;
}) {
  const { emoji, color } = notifIcon(notification.type);

  return (
    <button
      type="button"
      onClick={() => {
        if (!notification.is_read) onRead(notification.id);
      }}
      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 ${
        notification.is_read ? "opacity-60" : ""
      }`}
    >
      <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm ${color}`}>
        {emoji}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{notification.title}</p>
          {!notification.is_read && (
            <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
          {notification.body}
        </p>
        <p className="mt-1 text-[10px] text-muted-foreground">
          {timeAgo(notification.created_at)}
        </p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// DashboardHeader
// ---------------------------------------------------------------------------

export default function DashboardHeader() {
  const { user, signOut } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const { data: notifications } = useNotifications();
  const unreadCount = useNotificationCount();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllRead();

  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [open]);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      {/* Left — business name */}
      <div className="flex items-center gap-3">
        <Link to="/owner" className="text-lg font-bold text-primary">
          KaziOne
        </Link>
        {tenant && (
          <span className="hidden text-sm text-muted-foreground sm:inline">
            · {tenant.businessName}
          </span>
        )}
      </div>

      {/* Right — bell + avatar */}
      <div className="flex items-center gap-2">
        {/* ── Notification bell ──────────────────────────── */}
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setOpen((prev) => !prev)}
            className="relative rounded-md p-2 hover:bg-accent"
            aria-label="Notifications"
          >
            {/* Bell SVG */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
            >
              <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
              <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
            </svg>

            {/* Unread badge */}
            {unreadCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>

          {/* ── Dropdown ─────────────────────────────────── */}
          {open && (
            <div className="absolute right-0 top-full mt-2 w-80 overflow-hidden rounded-lg border bg-card shadow-xl sm:w-96">
              {/* Header */}
              <div className="flex items-center justify-between border-b px-4 py-2.5">
                <h3 className="text-sm font-semibold">Notifications</h3>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={() => markAllRead.mutate()}
                    disabled={markAllRead.isPending}
                    className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    Mark all read
                  </button>
                )}
              </div>

              {/* List */}
              <div className="max-h-[400px] divide-y overflow-y-auto">
                {(!notifications || notifications.length === 0) ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No notifications yet
                  </div>
                ) : (
                  notifications.map((n) => (
                    <NotificationItem
                      key={n.id}
                      notification={n}
                      onRead={(id) => markRead.mutate(id)}
                    />
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── User avatar / sign out ─────────────────────── */}
        <button
          type="button"
          onClick={() => signOut()}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
          title="Sign out"
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
            {user?.email?.[0]?.toUpperCase() ?? "U"}
          </span>
          <span className="hidden text-sm sm:inline">
            {user?.email?.split("@")[0]}
          </span>
        </button>
      </div>
    </header>
  );
}
