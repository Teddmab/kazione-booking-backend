import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

const DEADLINE_LABELS: Record<string, string> = {
  vat_return: "VAT return",
  bookkeeping_close: "Monthly bookkeeping close",
  annual_report: "Annual report",
};

/**
 * /tax-deadline-notifier — delivers "Set reminder" on the Tax & Reports page.
 *
 * Queries tax_deadline_reminders where remind_at has passed and
 * notified_at IS NULL, inserts one notifications row per match (targeted
 * at the user who set the reminder), then stamps notified_at.
 *
 * Same maturity level as commission-reminder: an invokable endpoint guarded
 * by a shared secret, not yet wired to a live schedule — Supabase's native
 * cron requires the Pro plan (see supabase/config.toml). Call with POST and
 * header x-cron-secret: <CRON_SECRET env var>.
 */
Deno.serve(withLogging("tax-deadline-notifier", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

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
    const nowIso = new Date().toISOString();

    const { data: dueReminders, error } = await supabaseAdmin
      .from("tax_deadline_reminders")
      .select("id, business_id, deadline_key, remind_at, created_by")
      .is("notified_at", null)
      .lte("remind_at", nowIso)
      .limit(200);

    if (error) return serverError(error.message);

    const reminders = (dueReminders ?? []) as Record<string, unknown>[];
    let notified = 0;

    for (const reminder of reminders) {
      const label = DEADLINE_LABELS[reminder.deadline_key as string] ?? "Tax deadline";
      const { error: insertErr } = await supabaseAdmin.from("notifications").insert({
        business_id: reminder.business_id,
        user_id: reminder.created_by,
        type: "tax_deadline",
        title: `${label} reminder`,
        body: `Your ${label.toLowerCase()} deadline is coming up.`,
        metadata: { deadline_key: reminder.deadline_key, remind_at: reminder.remind_at },
      });
      if (insertErr) {
        console.error(`[tax-deadline-notifier] Failed to notify reminder id=${reminder.id}:`, insertErr.message);
        continue;
      }

      const { error: updateErr } = await supabaseAdmin
        .from("tax_deadline_reminders")
        .update({ notified_at: nowIso })
        .eq("id", reminder.id);
      if (updateErr) {
        console.error(`[tax-deadline-notifier] Failed to mark reminder id=${reminder.id} notified:`, updateErr.message);
        continue;
      }
      notified++;
    }

    return jsonCors(req, { notified });
  } catch (e) {
    console.error("tax-deadline-notifier error:", e);
    return serverError("Unexpected error");
  }
}));
