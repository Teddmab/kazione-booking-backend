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

  const results = await Promise.all(
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

  return results.filter((r) => r.status === "unreachable" || r.status < 200 || r.status >= 300);
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

  const [{ data: unnotified }, { data: settingsRow }, unhealthy] = await Promise.all([
    supabaseAdmin
      .from("platform_error_log")
      .select("id, function_name, method, status_code, message, created_at")
      .is("notified_at", null)
      .order("created_at", { ascending: true })
      .limit(200),
    supabaseAdmin.from("platform_alert_settings").select("alert_email").eq("id", 1).maybeSingle(),
    checkHealth(),
  ]);

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

  // Group errors by function so a burst of the same failure reads as one
  // line, not 40.
  const byFunction = new Map<string, { count: number; statuses: Set<number>; sample: string | null }>();
  for (const row of errorRows) {
    const key = row.function_name;
    const agg = byFunction.get(key) ?? { count: 0, statuses: new Set<number>(), sample: null };
    agg.count += 1;
    agg.statuses.add(row.status_code);
    agg.sample ??= row.message;
    byFunction.set(key, agg);
  }

  const errorLines = Array.from(byFunction.entries())
    .map(([fn, agg]) =>
      `<li><strong>${fn}</strong> — ${agg.count} error(s), status ${[...agg.statuses].join(", ")}` +
      (agg.sample ? `<br><span style="color:#6B4C42">${agg.sample}</span>` : "") + `</li>`
    )
    .join("");

  const healthLines = unhealthy
    .map((h) => `<li><strong>${h.name}</strong> — ${h.status === "unreachable" ? "unreachable" : `HTTP ${h.status}`}</li>`)
    .join("");

  const subject = unhealthy.length > 0
    ? `🔴 KaziOne: ${unhealthy.length} endpoint(s) down`
    : `⚠️ KaziOne: ${errorRows.length} server error(s) in the last check`;

  const html = `
    <h2>KaziOne platform alert</h2>
    ${unhealthy.length > 0 ? `<h3>Unreachable endpoints</h3><ul>${healthLines}</ul>` : ""}
    ${errorRows.length > 0 ? `<h3>Server errors (5xx) since last check</h3><ul>${errorLines}</ul>` : ""}
    <p style="color:#6B4C42;font-size:12px">Sent by platform-alert-digest, runs every 15 minutes.</p>
  `;

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
