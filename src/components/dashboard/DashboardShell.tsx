import { Outlet } from "react-router-dom";
import { useAuthContext } from "../../contexts/AuthContext";
import { useTenantContext } from "../../contexts/TenantContext";
import AppSidebar from "./AppSidebar";
import DashboardHeader from "../DashboardHeader";

// ---------------------------------------------------------------------------
// Skeleton — shown while auth + tenant are resolving
// ---------------------------------------------------------------------------

function ShellSkeleton() {
  return (
    <div className="flex h-screen animate-pulse">
      {/* Sidebar skeleton */}
      <div className="hidden w-64 flex-col border-r bg-card lg:flex">
        <div className="flex items-center gap-2 border-b px-4 py-4">
          <div className="h-8 w-8 rounded-lg bg-muted" />
          <div className="h-5 w-24 rounded bg-muted" />
        </div>
        <div className="flex-1 space-y-1 px-2 py-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-9 rounded-md bg-muted" />
          ))}
        </div>
        <div className="border-t px-3 py-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-muted" />
            <div className="space-y-1.5">
              <div className="h-3.5 w-28 rounded bg-muted" />
              <div className="h-3 w-20 rounded bg-muted" />
            </div>
          </div>
        </div>
      </div>

      {/* Main area skeleton */}
      <div className="flex flex-1 flex-col">
        <div className="flex h-14 items-center justify-between border-b px-4">
          <div className="h-5 w-32 rounded bg-muted" />
          <div className="flex gap-2">
            <div className="h-8 w-8 rounded bg-muted" />
            <div className="h-8 w-8 rounded-full bg-muted" />
          </div>
        </div>
        <div className="flex-1 p-6">
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 rounded-lg bg-muted" />
            ))}
          </div>
          <div className="mt-6 h-64 rounded-lg bg-muted" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DashboardShell — layout wrapper for all dashboard routes
// ---------------------------------------------------------------------------

export default function DashboardShell() {
  const { loading: authLoading } = useAuthContext();
  const { loading: tenantLoading } = useTenantContext();

  if (authLoading || tenantLoading) {
    return <ShellSkeleton />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar — hidden on small screens */}
      <div className="hidden lg:block">
        <AppSidebar />
      </div>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <DashboardHeader />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
