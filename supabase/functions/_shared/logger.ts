import { corsHeaders } from "./cors.ts";
import { serverError } from "./errors.ts";

/**
 * Wrap an Edge Function handler with request logging and top-level error
 * catching. Logs { function_name, method, duration_ms, status_code } to
 * stdout (captured by Supabase logs). Does NOT log PII.
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

    try {
      const response = await handler(req);
      status = response.status;
      return response;
    } catch (err) {
      // Unhandled promise rejection — return 500 with CORS headers
      console.error(`[${functionName}] Unhandled error:`, err);
      const resp = serverError(
        err instanceof Error ? err.message : "Internal server error",
      );
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
    }
  };
}
