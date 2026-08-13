import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

/**
 * /commission-reminder — cron stub for overdue commission tasks
 *
 * Queries owner_tasks where resolved_at IS NULL and created_at older than 6 hours
 * and snoozed_until is past. Logs each overdue task for now; email notifications
 * will be wired in Sprint 5 (email infrastructure).
 *
 * Cron wiring: add to supabase/config.toml once S5 email is live.
 * Call with POST and an internal secret header: x-cron-secret: <CRON_SECRET env var>
 */
Deno.serve(withLogging("commission-reminder", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  // Guard: only allow POST with the correct cron secret
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  if (cronSecret) {
    const incoming = req.headers.get("x-cron-secret");
    if (incoming !== cronSecret) {
      return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "Invalid cron secret" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  try {
    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
    const nowIso = now.toISOString();

    const { data: overdueTasks, error } = await supabaseAdmin
      .from("owner_tasks")
      .select("id, business_id, title, body, created_at")
      .is("resolved_at", null)
      .lt("created_at", sixHoursAgo)
      .or(`snoozed_until.is.null,snoozed_until.lt.${nowIso}`)
      .order("created_at", { ascending: true })
      .limit(100);

    if (error) return serverError(error.message);

    const tasks = overdueTasks ?? [];
    for (const task of tasks as Record<string, unknown>[]) {
      // TODO(S5): send email notification via sendEmail()
      console.log(`[commission-reminder] Overdue task id=${task.id} business=${task.business_id} title="${task.title}" age=${Math.round((now.getTime() - new Date(task.created_at as string).getTime()) / 3600000)}h`);
    }

    return jsonCors(req, { reminded: tasks.length });
  } catch (e) {
    console.error("commission-reminder error:", e);
    return serverError("Unexpected error");
  }
}));
