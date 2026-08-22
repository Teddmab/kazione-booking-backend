import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson, adminErrors } from "../_shared/adminCors.ts";
import { requirePlatformAdmin } from "../_shared/adminAuth.ts";
import { withLogging } from "../_shared/logger.ts";

type Range = "24h" | "7d" | "30d";

const RANGE_HOURS: Record<Range, number> = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };

interface MetricRow {
  function_name: string;
  hour_bucket: string;
  request_count: number;
  error_count: number;
  total_duration_ms: number;
}

/**
 * /admin-monitoring — platform-admin system health dashboard data (S76)
 *
 * GET ?range=24h|7d|30d (default 24h)
 *   → { timeseries, top_errors, health }
 *
 *   timeseries: one point per hour (range=24h) or per day (7d/30d) —
 *     { bucket, request_count, error_count, avg_duration_ms } summed across
 *     every function, for the top-line volume/error-rate/latency charts.
 *   top_errors: functions with the most errors in the period, for a
 *     "what's actually breaking" list.
 *   health: latest status per business-critical endpoint (from
 *     platform-alert-digest's health-check sweep) plus an uptime percentage
 *     over the last 24h of checks.
 */
Deno.serve(withLogging("admin-monitoring", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  if (req.method !== "GET") {
    return adminErrors.badRequest("GET only");
  }

  const url = new URL(req.url);
  const rangeParam = (url.searchParams.get("range") ?? "24h") as Range;
  if (!(rangeParam in RANGE_HOURS)) {
    return adminErrors.badRequest("range must be one of: 24h, 7d, 30d");
  }

  const since = new Date(Date.now() - RANGE_HOURS[rangeParam] * 60 * 60 * 1000).toISOString();
  // uptime_pct_24h is deliberately always a fixed 24h window (a stable KPI),
  // independent of whatever range chart the admin has selected.
  const uptimeSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const [metricsRes, healthHistoryRes, errorSamplesRes] = await Promise.all([
      supabaseAdmin
        .from("platform_metrics_hourly")
        .select("function_name, hour_bucket, request_count, error_count, total_duration_ms")
        .gte("hour_bucket", since)
        .order("hour_bucket", { ascending: true })
        .limit(20000),
      // Last 5000 health-check rows across every endpoint (checks run every
      // 15 min for ~6 endpoints, so this comfortably covers several weeks) —
      // used both for the latest-status board and each endpoint's history.
      supabaseAdmin
        .from("platform_endpoint_health")
        .select("endpoint_name, checked_at, status, http_status")
        .order("checked_at", { ascending: false })
        .limit(5000),
      // Actual error messages within the SAME selected range as the rest of
      // the dashboard (not a fixed 24h) — retrieving as much real log detail
      // as the admin asked for via the range picker is the point of this
      // endpoint existing at all.
      supabaseAdmin
        .from("platform_error_log")
        .select("function_name, status_code, message, created_at")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5000),
    ]);

    if (metricsRes.error || healthHistoryRes.error || errorSamplesRes.error) {
      const msg = metricsRes.error?.message ?? healthHistoryRes.error?.message ?? errorSamplesRes.error?.message ?? "Unknown error";
      console.error("[admin-monitoring] fetch error:", msg);
      return adminErrors.serverError(msg);
    }

    const rows = (metricsRes.data ?? []) as MetricRow[];

    // Bucket into per-hour (24h range) or per-day (7d/30d range) points,
    // summed across every function.
    const dayGranularity = rangeParam !== "24h";
    const bucketKey = (iso: string) => (dayGranularity ? iso.slice(0, 10) : iso.slice(0, 13));

    const buckets = new Map<string, { request_count: number; error_count: number; total_duration_ms: number }>();
    for (const row of rows) {
      const key = bucketKey(row.hour_bucket);
      const agg = buckets.get(key) ?? { request_count: 0, error_count: 0, total_duration_ms: 0 };
      agg.request_count += row.request_count;
      agg.error_count += row.error_count;
      agg.total_duration_ms += row.total_duration_ms;
      buckets.set(key, agg);
    }

    const timeseries = Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([bucket, agg]) => ({
        bucket,
        request_count: agg.request_count,
        error_count: agg.error_count,
        avg_duration_ms: agg.request_count > 0 ? Math.round(agg.total_duration_ms / agg.request_count) : 0,
      }));

    // Top erroring functions in the period, each with a few of its most
    // recent real error messages — this is what a click on the row expands
    // to show, so an admin can see what's actually breaking, not just a count.
    const byFunction = new Map<string, { request_count: number; error_count: number }>();
    for (const row of rows) {
      const agg = byFunction.get(row.function_name) ?? { request_count: 0, error_count: 0 };
      agg.request_count += row.request_count;
      agg.error_count += row.error_count;
      byFunction.set(row.function_name, agg);
    }

    const errorSamples = (errorSamplesRes.data ?? []) as {
      function_name: string; status_code: number; message: string | null; created_at: string;
    }[];
    const samplesByFunction = new Map<string, { status_code: number; message: string | null; created_at: string }[]>();
    for (const row of errorSamples) {
      const list = samplesByFunction.get(row.function_name) ?? [];
      if (list.length < 30) list.push({ status_code: row.status_code, message: row.message, created_at: row.created_at });
      samplesByFunction.set(row.function_name, list);
    }

    const topErrors = Array.from(byFunction.entries())
      .map(([function_name, agg]) => ({
        function_name,
        ...agg,
        recent_errors: samplesByFunction.get(function_name) ?? [],
      }))
      .filter((f) => f.error_count > 0)
      .sort((a, b) => b.error_count - a.error_count)
      .slice(0, 10);

    // Per-endpoint history (most recent first) — the latest entry is the
    // current status; the full list is what a click on a status card
    // expands to show.
    const historyByEndpoint = new Map<string, { checked_at: string; status: string; http_status: number | null }[]>();
    for (const row of (healthHistoryRes.data ?? []) as { endpoint_name: string; checked_at: string; status: string; http_status: number | null }[]) {
      const list = historyByEndpoint.get(row.endpoint_name) ?? [];
      list.push({ checked_at: row.checked_at, status: row.status, http_status: row.http_status });
      historyByEndpoint.set(row.endpoint_name, list);
    }

    const dayAgo = uptimeSince;
    const health = Array.from(historyByEndpoint.entries()).map(([endpoint_name, history]) => {
      const last24h = history.filter((h) => h.checked_at >= dayAgo);
      const upCount = last24h.filter((h) => h.status === "up").length;
      const latest = history[0];
      return {
        endpoint_name,
        status: latest.status,
        http_status: latest.http_status,
        checked_at: latest.checked_at,
        uptime_pct_24h: last24h.length > 0 ? Math.round((upCount / last24h.length) * 1000) / 10 : null,
        history: history.slice(0, 96),
      };
    }).sort((a, b) => a.endpoint_name.localeCompare(b.endpoint_name));

    return adminJson({ range: rangeParam, timeseries, top_errors: topErrors, health });
  } catch (err) {
    console.error("[admin-monitoring]", err);
    return adminErrors.serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
