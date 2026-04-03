import { Navigate, Outlet } from "react-router-dom";
import { useAuthContext } from "../../contexts/AuthContext";
import { useTenantContext } from "../../contexts/TenantContext";
import type { MemberRole } from "../../contexts/TenantContext";

// ---------------------------------------------------------------------------
// ProtectedRoute
//
// requireTenant = true  → user must be logged in AND have a business membership
// requireTenant = false → user must be logged in (no business check)
// allowedRoles          → optional role whitelist (only if requireTenant=true)
// ---------------------------------------------------------------------------

interface ProtectedRouteProps {
  requireTenant?: boolean;
  allowedRoles?: MemberRole[];
}

export default function ProtectedRoute({
  requireTenant = false,
  allowedRoles,
}: ProtectedRouteProps) {
  const { user, loading: authLoading } = useAuthContext();
  const { tenant, loading: tenantLoading } = useTenantContext();

  // Still resolving auth state — show nothing (parent shell shows skeleton)
  if (authLoading) return null;

  // Not authenticated → redirect to login
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Tenant required but still loading → show nothing
  if (requireTenant && tenantLoading) return null;

  // Tenant required but user has no business membership
  if (requireTenant && !tenant) {
    return <Navigate to="/unauthorized" replace />;
  }

  // Role check
  if (requireTenant && allowedRoles && tenant && !allowedRoles.includes(tenant.role)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <Outlet />;
}
