import { supabaseAdmin } from "./supabaseAdmin.ts";

/**
 * Records one request against the current hour's rollup row for this
 * function (atomic upsert via record_platform_metric — see migration
 * 118_monitoring_mvp.sql). Fire-and-forget, called from every request by
 * _shared/logger.ts's withLogging — must never throw or block the response
 * already being returned to the caller.
 */
export function recordPlatformMetric(
  functionName: string,
  isError: boolean,
  durationMs: number,
): void {
  try {
    supabaseAdmin
      .rpc("record_platform_metric", {
        p_function_name: functionName,
        p_is_error: isError,
        p_duration_ms: Math.round(durationMs),
      })
      .then(({ error }) => {
        if (error) console.error("[platformMetrics] RPC failed:", error.message);
      });
  } catch (err) {
    console.error("[platformMetrics] Unexpected error:", err);
  }
}
