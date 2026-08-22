import { serverError } from "./errors.ts";
import { logPlatformError } from "./platformAlert.ts";
import { recordPlatformMetric } from "./platformMetrics.ts";

/**
 * Wrap an Edge Function handler with request logging and top-level error
 * catching. Logs { function_name, method, duration_ms, status_code } to
 * stdout (captured by Supabase logs). Does NOT log PII.
 *
 * Any 5xx response is also recorded to platform_error_log for
 * platform-alert-digest to pick up — this is how an outage like a function
 * silently 500ing (or crashing) gets surfaced as an email alert instead of
 * only showing up in Supabase logs nobody is watching in real time.
 *
 * Every request (not just 5xx) is also rolled up into platform_metrics_hourly
 * via an atomic upsert RPC — this feeds the admin Monitoring dashboard's
 * request-volume/error-rate/latency charts.
 *
 * Usage:
 *   Deno.serve(withLogging("create-booking", handler));
 */
export function withLogging(
  functionName: string,
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const start = Date.now();
    let status = 500;
    let errorMessage: string | undefined;

    try {
      const response = await handler(req);
      status = response.status;
      return response;
    } catch (err) {
      // Unhandled promise rejection — return 500 with CORS headers
      console.error(`[${functionName}] Unhandled error:`, err);
      errorMessage = err instanceof Error ? err.message : String(err);
      const resp = serverError(errorMessage);
      status = resp.status;
      return resp;
    } finally {
      const duration_ms = Date.now() - start;
      console.log(
        JSON.stringify({
          function_name: functionName,
          method: req.method,
          duration_ms,
          status_code: status,
        }),
      );
      if (status >= 500) {
        logPlatformError(functionName, req.method, status, errorMessage);
      }
      recordPlatformMetric(functionName, status >= 500, duration_ms);
    }
  };
}
