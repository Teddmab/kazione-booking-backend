import { supabaseAdmin } from "./supabaseAdmin.ts";

/**
 * Records a 5xx response for platform-alert-digest to pick up and email.
 * Fire-and-forget — mirrors the existing admin_audit_log/staff_action_log/
 * review_moderation_log insert-only audit pattern. Called from
 * _shared/logger.ts's withLogging, so this must never throw or block the
 * response already being returned to the caller.
 */
export function logPlatformError(
  functionName: string,
  method: string,
  status: number,
  message?: string,
): void {
  try {
    supabaseAdmin
      .from("platform_error_log")
      .insert({
        function_name: functionName,
        method,
        status_code: status,
        message: message?.slice(0, 500) ?? null,
      })
      .then(({ error }) => {
        if (error) console.error("[platformAlert] Insert failed:", error.message);
      });
  } catch (err) {
    console.error("[platformAlert] Unexpected error:", err);
  }
}
