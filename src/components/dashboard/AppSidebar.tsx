import { Link, useLocation } from "react-router-dom";
import { useAuth, useUserProfile, useTenant } from "../../hooks/useAuth";

const navItems = [
  { label: "Dashboard", path: "/owner", icon: "📊" },
  { label: "Appointments", path: "/owner/appointments", icon: "📅" },
  { label: "Clients", path: "/owner/clients", icon: "👥" },
  { label: "Finance", path: "/owner/finance", icon: "💰" },
  { label: "Suppliers", path: "/owner/suppliers", icon: "📦" },
  { label: "Reports", path: "/owner/reports", icon: "📋" },
  { label: "AI Insights", path: "/owner/ai-insights", icon: "🤖" },
  { label: "Storefront", path: "/owner/storefront", icon: "🏪" },
];

const roleColors: Record<string, string> = {
  owner: "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200",
  manager: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  staff: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  receptionist: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
};

export default function AppSidebar() {
  const location = useLocation();
  const { user, signOut } = useAuth();
  const { data: profile } = useUserProfile(user?.id);
  const { data: tenant } = useTenant(user?.id);

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-card">
      {/* ── Brand ────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
          K
        </div>
        <span className="text-lg font-semibold">KaziOne</span>
      </div>

      {/* ── Navigation ───────────────────────────────────────── */}
      <nav className="flex-1 space-y-0.5 overflow-auto px-2 py-3">
        {navItems.map((item) => {
          const isActive =
            location.pathname === item.path ||
            (item.path !== "/owner" &&
              location.pathname.startsWith(item.path));
          return (
            <Link
              key={item.path}
              to={item.path}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <span>{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* ── Footer — user & business info ────────────────────── */}
      <div className="border-t px-3 py-3">
        <div className="flex items-center gap-3">
          {/* Avatar */}
          {profile?.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt=""
              className="h-9 w-9 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-sm font-semibold">
              {profile?.full_name?.charAt(0) ?? user?.email?.charAt(0) ?? "?"}
            </div>
          )}

          {/* Name + business */}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">
              {profile?.full_name ?? user?.email ?? "Loading…"}
            </p>
            <div className="flex items-center gap-1.5">
              {tenant && (
                <>
                  <span className="truncate text-xs text-muted-foreground">
                    {tenant.businessName}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${
                      roleColors[tenant.role] ?? "bg-muted"
                    }`}
                  >
                    {tenant.role}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Sign out */}
        <button
          onClick={signOut}
          className="mt-2 w-full rounded-md border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
