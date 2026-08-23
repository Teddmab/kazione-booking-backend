// Single source of truth for which edge functions are "business critical"
// enough to health-check and surface on the admin Ops page, grouped by the
// portal whose experience actually breaks if the endpoint is down.
//
// Used by:
//   - platform-alert-digest/index.ts — the health-check sweep itself
//   - admin-monitoring/index.ts — attaches `portal` to each health row so
//     the admin UI can group Endpoint Health by Client / Owner / Staff
//     instead of one flat list
//
// A handful of endpoints genuinely serve more than one portal (e.g.
// `appointments` backs both the owner dashboard and the staff schedule
// view, `staff` backs both owner-side staff management and staff
// self-service). Each is listed once, under whichever portal it's most
// distinctly associated with — this is a grouping for a health dashboard,
// not a claim of exclusive ownership.

export type Portal = "client" | "owner" | "staff";

export interface CriticalEndpoint {
  name: string;
  portal: Portal;
}

export const CRITICAL_ENDPOINTS: CriticalEndpoint[] = [
  // ── Client / public marketplace + booking ──────────────────────────────
  { name: "get-storefront", portal: "client" },
  { name: "marketplace-storefronts", portal: "client" },
  { name: "get-availability", portal: "client" },
  { name: "create-booking", portal: "client" },
  { name: "cancel-booking", portal: "client" },
  { name: "reschedule-booking", portal: "client" },
  { name: "get-booking", portal: "client" },
  { name: "lookup-booking", portal: "client" },
  { name: "auth-register", portal: "client" },
  { name: "me", portal: "client" },
  { name: "gdpr", portal: "client" },
  { name: "reviews", portal: "client" },

  // ── Owner dashboard ─────────────────────────────────────────────────────
  { name: "appointments", portal: "owner" },
  { name: "clients", portal: "owner" },
  { name: "services", portal: "owner" },
  { name: "offers", portal: "owner" },
  { name: "finance", portal: "owner" },
  { name: "storefront-owner", portal: "owner" },
  { name: "stripe-connect", portal: "owner" },
  { name: "create-business", portal: "owner" },
  { name: "invite-staff", portal: "owner" },
  { name: "export-report", portal: "owner" },
  { name: "products", portal: "owner" },
  { name: "send-reminders", portal: "owner" },

  // ── Staff dashboard ─────────────────────────────────────────────────────
  { name: "staff", portal: "staff" },
  { name: "accept-staff-invite", portal: "staff" },
  { name: "training", portal: "staff" },
];

export const CRITICAL_ENDPOINT_NAMES: string[] = CRITICAL_ENDPOINTS.map((e) => e.name);

const PORTAL_BY_NAME = new Map(CRITICAL_ENDPOINTS.map((e) => [e.name, e.portal]));

/** Falls back to "owner" for any historical endpoint_name no longer in the current list. */
export function portalFor(endpointName: string): Portal {
  return PORTAL_BY_NAME.get(endpointName) ?? "owner";
}
