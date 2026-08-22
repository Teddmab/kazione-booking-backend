import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { withLogging } from "../_shared/logger.ts";
import { sendEmail } from "../_shared/resend.ts";

/**
 * /platform-alert-digest — cron job (CRON_SECRET-gated, POST only)
 *
 * Runs every 15 minutes (see .github/workflows/alert-digest.yml). Two jobs:
 *
 * 1. Drains any unnotified rows from platform_error_log (every 5xx any edge
 *    function returned since the last run — see _shared/logger.ts) into one
 *    summary email, then marks them notified.
 * 2. Health-checks a fixed list of business-critical endpoints with a plain
 *    OPTIONS request — the same request the browser's own CORS preflight
 *    makes — so a function that's silently unreachable at the gateway
 *    (wrong status, deploy corruption, etc.) is caught even with zero real
 *    traffic hitting it. This is what would have caught create-booking's
 *    NOT_FOUND_FUNCTION_BLOB outage immediately instead of not at all.
 *
 * No alert email is sent if platform_alert_settings.alert_email is unset —
 * this is deliberately admin-configured, not a hardcoded fallback address.
 */

// ---------------------------------------------------------------------------
// Auth — CRON_SECRET header check (mirrors send-reminders/index.ts)
// ---------------------------------------------------------------------------

const CRON_SECRET = Deno.env.get("CRON_SECRET");

function verifyCronAuth(req: Request): boolean {
  if (!CRON_SECRET) {
    console.error("[platform-alert-digest] CRON_SECRET env var is not set");
    return false;
  }
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;

  const token = header.replace("Bearer ", "");
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(CRON_SECRET);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Health check — fixed list of endpoints no real booking flow can work
// without. A plain OPTIONS request, same as a browser's CORS preflight.
// ---------------------------------------------------------------------------

const CRITICAL_ENDPOINTS = [
  "create-booking",
  "get-storefront",
  "get-availability",
  "cancel-booking",
  "reschedule-booking",
  "me",
];

async function checkHealth(): Promise<{ name: string; status: number | "unreachable" }[]> {
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return [];

  return await Promise.all(
    CRITICAL_ENDPOINTS.map(async (name) => {
      try {
        const res = await fetch(`${base}/functions/v1/${name}`, {
          method: "OPTIONS",
          headers: { Origin: "https://kazione.app", "Access-Control-Request-Method": "POST" },
          signal: AbortSignal.timeout(8000),
        });
        return { name, status: res.status };
      } catch {
        return { name, status: "unreachable" as const };
      }
    }),
  );
}

/**
 * Persists every health-check result (not just failures) so the admin
 * Monitoring page can render an uptime status board, not just receive
 * alert emails when something's already broken.
 */
async function recordHealthResults(results: { name: string; status: number | "unreachable" }[]): Promise<void> {
  if (results.length === 0) return;
  const rows = results.map((r) => ({
    endpoint_name: r.name,
    status: r.status === "unreachable" || r.status < 200 || r.status >= 300 ? "down" : "up",
    http_status: r.status === "unreachable" ? null : r.status,
  }));
  const { error } = await supabaseAdmin.from("platform_endpoint_health").insert(rows);
  if (error) console.error("[platform-alert-digest] Failed to record health results:", error.message);
}

// ---------------------------------------------------------------------------
// Email body — grouped by function, then by (status, message) so a burst of
// identical failures reads as one line with a count, but a function
// throwing several distinct errors shows each one, not just the first
// sample seen. This is the actual diagnostic detail an admin needs to fix
// something, not just a count.
// ---------------------------------------------------------------------------

interface ErrorRow {
  function_name: string;
  method: string;
  status_code: number;
  message: string | null;
  created_at: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildAlertEmailHtml(
  errorRows: ErrorRow[],
  unhealthy: { name: string; status: number | "unreachable" }[],
): string {
  const dashboardUrl = Deno.env.get("ADMIN_ALLOWED_ORIGIN") ?? "https://kazione-booking-admin.pages.dev";

  const healthSection = unhealthy.length === 0 ? "" : `
    <h3 style="margin-bottom:6px">Unreachable endpoints</h3>
    <ul style="margin-top:0">
      ${unhealthy.map((h) =>
        `<li><strong>${escapeHtml(h.name)}</strong> — ${h.status === "unreachable" ? "unreachable (timeout or network error)" : `HTTP ${h.status}`}</li>`
      ).join("")}
    </ul>
  `;

  let errorSection = "";
  if (errorRows.length > 0) {
    // function_name → (status_code|message) → { count, method, lastSeen }
    const byFunction = new Map<string, Map<string, { count: number; status: number; method: string; message: string | null; lastSeen: string }>>();
    for (const row of errorRows) {
      const fnMap = byFunction.get(row.function_name) ?? new Map();
      const variantKey = `${row.status_code}|${row.message ?? ""}`;
      const variant = fnMap.get(variantKey) ?? { count: 0, status: row.status_code, method: row.method, message: row.message, lastSeen: row.created_at };
      variant.count += 1;
      if (row.created_at > variant.lastSeen) variant.lastSeen = row.created_at;
      fnMap.set(variantKey, variant);
      byFunction.set(row.function_name, fnMap);
    }

    const functionBlocks = Array.from(byFunction.entries()).map(([fn, variants]) => {
      const total = Array.from(variants.values()).reduce((s, v) => s + v.count, 0);
      const variantLines = Array.from(variants.values())
        .sort((a, b) => b.count - a.count)
        .map((v) => `
          <div style="margin:4px 0 4px 12px;padding:8px 10px;background:#FDF3F0;border-left:3px solid #E84E26;border-radius:4px">
            <div style="font-size:12px;color:#6B4C42">
              <strong style="color:#C43D1A">${v.status}</strong> · ${escapeHtml(v.method)} · ${v.count}× · last ${new Date(v.lastSeen).toLocaleString()}
            </div>
            <div style="font-family:ui-monospace,monospace;font-size:12px;color:#1A0F0A;margin-top:3px;word-break:break-word">
              ${v.message ? escapeHtml(v.message) : "<em>(no message captured)</em>"}
            </div>
          </div>
        `).join("");

      return `
        <div style="margin-bottom:10px">
          <p style="margin:0 0 2px;font-size:14px"><strong>${escapeHtml(fn)}</strong> — ${total} error${total > 1 ? "s" : ""}</p>
          ${variantLines}
        </div>
      `;
    }).join("");

    errorSection = `
      <h3 style="margin-bottom:6px">Server errors (5xx) since last check</h3>
      ${functionBlocks}
    `;
  }

  return `
    <h2>KaziOne platform alert</h2>
    ${healthSection}
    ${errorSection}
    <p style="margin-top:16px">
      <a href="${dashboardUrl}/monitoring" style="color:#E84E26">View live in the admin dashboard →</a>
    </p>
    <p style="color:#6B4C42;font-size:12px">Sent by platform-alert-digest, runs every 15 minutes.</p>
  `;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("platform-alert-digest", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return jsonCors(req, { error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } }, 405);
  }

  if (!verifyCronAuth(req)) {
    return jsonCors(req, { error: { code: "FORBIDDEN", message: "Invalid cron secret" } }, 403);
  }

  const [{ data: unnotified }, { data: settingsRow }, healthResults] = await Promise.all([
    supabaseAdmin
      .from("platform_error_log")
      .select("id, function_name, method, status_code, message, created_at")
      .is("notified_at", null)
      .order("created_at", { ascending: true })
      .limit(200),
    supabaseAdmin.from("platform_alert_settings").select("alert_email").eq("id", 1).maybeSingle(),
    checkHealth(),
  ]);

  // Record every check (not just failures) for the Monitoring page's uptime
  // status board — fire-and-forget-ish, but we do wait for it here since
  // this cron run has no response deadline pressure like a user request.
  await recordHealthResults(healthResults);

  const unhealthy = healthResults.filter((r) => r.status === "unreachable" || r.status < 200 || r.status >= 300);

  const errorRows = (unnotified ?? []) as {
    id: string; function_name: string; method: string; status_code: number; message: string | null; created_at: string;
  }[];
  const alertEmail = (settingsRow as { alert_email: string | null } | null)?.alert_email;

  if (errorRows.length === 0 && unhealthy.length === 0) {
    return jsonCors(req, { errors_found: 0, unhealthy_endpoints: 0, emailed: false });
  }

  if (!alertEmail) {
    console.warn(
      `[platform-alert-digest] ${errorRows.length} error(s) + ${unhealthy.length} unhealthy endpoint(s), ` +
      `but no alert_email configured — set one in the admin portal to receive alerts.`,
    );
    return jsonCors(req, { errors_found: errorRows.length, unhealthy_endpoints: unhealthy.length, emailed: false, reason: "no alert_email configured" });
  }

  const html = buildAlertEmailHtml(errorRows, unhealthy);
  const subject = unhealthy.length > 0
    ? `🔴 KaziOne: ${unhealthy.length} endpoint(s) down`
    : `⚠️ KaziOne: ${errorRows.length} server error(s) in the last check`;

  try {
    await sendEmail(alertEmail, subject, html);
  } catch (err) {
    console.error("[platform-alert-digest] Failed to send alert email:", err);
    return jsonCors(req, { errors_found: errorRows.length, unhealthy_endpoints: unhealthy.length, emailed: false, reason: "send failed" }, 500);
  }

  if (errorRows.length > 0) {
    await supabaseAdmin
      .from("platform_error_log")
      .update({ notified_at: new Date().toISOString() })
      .in("id", errorRows.map((r) => r.id));
  }

  return jsonCors(req, { errors_found: errorRows.length, unhealthy_endpoints: unhealthy.length, emailed: true });
}));
