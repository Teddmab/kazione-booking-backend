import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./contexts/AuthContext";
import { TenantProvider } from "./contexts/TenantContext";
import ProtectedRoute from "./components/auth/ProtectedRoute";
import DashboardShell from "./components/dashboard/DashboardShell";
import ErrorBoundary from "./components/ErrorBoundary";

// ---------------------------------------------------------------------------
// Lazy-loaded pages
// ---------------------------------------------------------------------------

// Auth
const LoginPage = lazy(() => import("./pages/auth/LoginPage"));
const SignupPage = lazy(() => import("./pages/auth/SignupPage"));
const CheckEmailPage = lazy(() => import("./pages/auth/CheckEmailPage"));
const UnauthorizedPage = lazy(() => import("./pages/auth/UnauthorizedPage"));

// Dashboard — owner
const OwnerDashboard = lazy(() => import("./pages/dashboard/OwnerDashboard"));
const AppointmentsPage = lazy(() => import("./pages/dashboard/owner/AppointmentsPage"));
const ClientsPage = lazy(() => import("./pages/dashboard/owner/ClientsPage"));
const FinancePage = lazy(() => import("./pages/dashboard/owner/FinancePage"));
const ReportsPage = lazy(() => import("./pages/dashboard/owner/ReportsPage"));
const StorefrontEditorPage = lazy(() => import("./pages/dashboard/owner/StorefrontEditorPage"));
const AIInsightsPage = lazy(() => import("./pages/dashboard/owner/AIInsightsPage"));
const SuppliersPage = lazy(() => import("./pages/dashboard/owner/SuppliersPage"));

// Marketplace (public)
const BrowseSalons = lazy(() => import("./pages/marketplace/BrowseSalons"));
const SalonStorefront = lazy(() => import("./pages/SalonStorefront"));
const SalonServices = lazy(() => import("./pages/SalonServices"));
const SalonBooking = lazy(() => import("./pages/SalonBooking"));

// Customer (auth required, no tenant)
const CustomerBookings = lazy(() => import("./pages/CustomerBookings"));
const BookingDetail = lazy(() => import("./pages/BookingDetail"));

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

function PageLoader() {
  return (
    <div className="flex h-full min-h-[200px] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
    </div>
  );
}

/** Wrap any page element with ErrorBoundary for per-route crash isolation */
function E({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <TenantProvider>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              {/* ── Public auth pages ──────────────────────── */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/signup" element={<SignupPage />} />
              <Route path="/signup/check-email" element={<CheckEmailPage />} />
              <Route path="/unauthorized" element={<UnauthorizedPage />} />

              {/* ── Auth callback → redirect to owner dashboard ── */}
              <Route
                path="/auth/callback"
                element={<Navigate to="/owner" replace />}
              />

              {/* ── Public marketplace ─────────────────────── */}
              <Route path="/" element={<Navigate to="/client/browse" replace />} />
              <Route path="/client/browse" element={<E><BrowseSalons /></E>} />
              <Route path="/client/salon/:slug" element={<E><SalonStorefront /></E>} />
              <Route path="/client/salon/:slug/services" element={<E><SalonServices /></E>} />
              <Route path="/client/salon/:slug/book" element={<E><SalonBooking /></E>} />

              {/* ── Customer routes (auth, no tenant) ──────── */}
              <Route element={<ProtectedRoute requireTenant={false} />}>
                <Route path="/client/bookings" element={<E><CustomerBookings /></E>} />
                <Route path="/client/bookings/:id" element={<E><BookingDetail /></E>} />
              </Route>

              {/* ── Partner routes (auth, no tenant) ───────── */}
              <Route element={<ProtectedRoute requireTenant={false} />}>
                <Route path="/partner/*" element={<div>Partner portal (coming soon)</div>} />
              </Route>

              {/* ── Owner dashboard (auth + tenant) ────────── */}
              <Route
                element={
                  <ProtectedRoute
                    requireTenant={true}
                    allowedRoles={["owner", "manager"]}
                  />
                }
              >
                <Route element={<DashboardShell />}>
                  <Route path="/owner" element={<E><OwnerDashboard /></E>} />
                  <Route path="/owner/appointments" element={<E><AppointmentsPage /></E>} />
                  <Route path="/owner/clients" element={<E><ClientsPage /></E>} />
                  <Route path="/owner/finance" element={<E><FinancePage /></E>} />
                  <Route path="/owner/reports" element={<E><ReportsPage /></E>} />
                  <Route path="/owner/storefront" element={<E><StorefrontEditorPage /></E>} />
                  <Route path="/owner/ai-insights" element={<E><AIInsightsPage /></E>} />
                  <Route path="/owner/suppliers" element={<E><SuppliersPage /></E>} />
                </Route>
              </Route>

              {/* ── Staff dashboard (auth + tenant) ────────── */}
              <Route
                element={
                  <ProtectedRoute
                    requireTenant={true}
                    allowedRoles={["owner", "manager", "staff"]}
                  />
                }
              >
                <Route element={<DashboardShell />}>
                  <Route path="/staff/*" element={<div>Staff dashboard (coming soon)</div>} />
                </Route>
              </Route>

              {/* ── Receptionist dashboard (auth + tenant) ─── */}
              <Route
                element={
                  <ProtectedRoute
                    requireTenant={true}
                    allowedRoles={["owner", "manager", "receptionist"]}
                  />
                }
              >
                <Route element={<DashboardShell />}>
                  <Route path="/receptionist/*" element={<div>Receptionist dashboard (coming soon)</div>} />
                </Route>
              </Route>

              {/* ── Legacy /dashboard redirects ────────────── */}
              <Route path="/dashboard" element={<Navigate to="/owner" replace />} />
              <Route path="/dashboard/*" element={<Navigate to="/owner" replace />} />

              {/* ── 404 ────────────────────────────────────── */}
              <Route
                path="*"
                element={
                  <div className="flex min-h-screen items-center justify-center">
                    <div className="text-center">
                      <h1 className="text-4xl font-bold">404</h1>
                      <p className="mt-2 text-muted-foreground">Page not found</p>
                    </div>
                  </div>
                }
              />
            </Routes>
          </Suspense>
        </TenantProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
