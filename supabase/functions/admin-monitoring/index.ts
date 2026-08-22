import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson } from "../_shared/adminCors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
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
    return badRequest("GET only");
  }

  const url = new URL(req.url);
  const rangeParam = (url.searchParams.get("range") ?? "24h") as Range;
  if (!(rangeParam in RANGE_HOURS)) {
    return badRequest("range must be one of: 24h, 7d, 30d");
  }

  const since = new Date(Date.now() - RANGE_HOURS[rangeParam] * 60 * 60 * 1000).toISOString();

  try {
    const [metricsRes, healthLatestRes, healthHistoryRes] = await Promise.all([
      supabaseAdmin
        .from("platform_metrics_hourly")
        .select("function_name, hour_bucket, request_count, error_count, total_duration_ms")
        .gte("hour_bucket", since)
        .order("hour_bucket", { ascending: true })
        .limit(20000),
      supabaseAdmin
        .from("platform_endpoint_health")
        .select("endpoint_name, checked_at, status, http_status")
        .order("checked_at", { ascending: false })
        .limit(500),
      supabaseAdmin
        .from("platform_endpoint_health")
        .select("endpoint_name, status")
        .gte("checked_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(5000),
    ]);

    if (metricsRes.error || healthLatestRes.error || healthHistoryRes.error) {
      console.error(
        "[admin-monitoring] fetch error:",
        metricsRes.error?.message ?? healthLatestRes.error?.message ?? healthHistoryRes.error?.message,
      );
      return serverError();
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

    // Top erroring functions in the period.
    const byFunction = new Map<string, { request_count: number; error_count: number }>();
    for (const row of rows) {
      const agg = byFunction.get(row.function_name) ?? { request_count: 0, error_count: 0 };
      agg.request_count += row.request_count;
      agg.error_count += row.error_count;
      byFunction.set(row.function_name, agg);
    }
    const topErrors = Array.from(byFunction.entries())
      .map(([function_name, agg]) => ({ function_name, ...agg }))
      .filter((f) => f.error_count > 0)
      .sort((a, b) => b.error_count - a.error_count)
      .slice(0, 10);

    // Latest status per endpoint, plus a simple check-count uptime % over 24h.
    const latestByEndpoint = new Map<string, { endpoint_name: string; checked_at: string; status: string; http_status: number | null }>();
    for (const row of (healthLatestRes.data ?? []) as { endpoint_name: string; checked_at: string; status: string; http_status: number | null }[]) {
      if (!latestByEndpoint.has(row.endpoint_name)) latestByEndpoint.set(row.endpoint_name, row);
    }
    const upCounts = new Map<string, { up: number; total: number }>();
    for (const row of (healthHistoryRes.data ?? []) as { endpoint_name: string; status: string }[]) {
      const agg = upCounts.get(row.endpoint_name) ?? { up: 0, total: 0 };
      agg.total += 1;
      if (row.status === "up") agg.up += 1;
      upCounts.set(row.endpoint_name, agg);
    }

    const health = Array.from(latestByEndpoint.values()).map((e) => {
      const counts = upCounts.get(e.endpoint_name) ?? { up: 0, total: 0 };
      return {
        endpoint_name: e.endpoint_name,
        status: e.status,
        http_status: e.http_status,
        checked_at: e.checked_at,
        uptime_pct_24h: counts.total > 0 ? Math.round((counts.up / counts.total) * 1000) / 10 : null,
      };
    }).sort((a, b) => a.endpoint_name.localeCompare(b.endpoint_name));

    return adminJson({ range: rangeParam, timeseries, top_errors: topErrors, health });
  } catch (err) {
    console.error("[admin-monitoring]", err);
    return serverError();
  }
}));
