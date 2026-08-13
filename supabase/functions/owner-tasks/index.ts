import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";

/**
 * /owner-tasks — owner task tray (commission reminders)
 *
 * GET  ?business_id=              → list unresolved tasks, ordered by created_at DESC
 * GET  ?business_id=&count=1      → { unresolved_count: number }
 * PATCH ?id=                      → resolve task  body: { method, note? }
 * PATCH ?id=&action=snooze        → snooze task   body: { until_iso }
 */
Deno.serve(withLogging("owner-tasks", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");
  const id = url.searchParams.get("id");

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      const countOnly = url.searchParams.get("count") === "1";

      const ctx = await requireOwnerOrManagerCtx(req, businessId ?? undefined);
      if (ctx instanceof Response) return ctx;

      const now = new Date().toISOString();

      if (countOnly) {
        const { count, error } = await supabaseAdmin
          .from("owner_tasks")
          .select("id", { count: "exact", head: true })
          .eq("business_id", ctx.businessId)
          .is("resolved_at", null)
          .or(`snoozed_until.is.null,snoozed_until.lt.${now}`);

        if (error) return serverError(error.message);
        return jsonCors(req, { unresolved_count: count ?? 0 });
      }

      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();

      const { data: tasks, error } = await supabaseAdmin
        .from("owner_tasks")
        .select("id, type, title, body, ref_id, ref_type, created_at, snoozed_until")
        .eq("business_id", ctx.businessId)
        .is("resolved_at", null)
        .or(`snoozed_until.is.null,snoozed_until.lt.${now}`)
        .order("created_at", { ascending: false });

      if (error) return serverError(error.message);

      const result = (tasks ?? []).map((t: Record<string, unknown>) => ({
        ...t,
        overdue: (t.created_at as string) < sixHoursAgo,
      }));

      return jsonCors(req, result);
    }

    // ── PATCH ─────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;

      const { data: task } = await supabaseAdmin
        .from("owner_tasks")
        .select("business_id, ref_id, ref_type, resolved_at")
        .eq("id", id)
        .maybeSingle();

      if (!task) return notFound("Task not found");
      const taskRow = task as { business_id: string; ref_id: string | null; ref_type: string | null; resolved_at: string | null };

      const ctx = await requireOwnerOrManagerCtx(req, taskRow.business_id);
      if (ctx instanceof Response) return ctx;

      // snooze
      if (action === "snooze") {
        const untilIso = body.until_iso as string | undefined;
        if (!untilIso) return badRequest("until_iso is required");

        const { error } = await supabaseAdmin
          .from("owner_tasks")
          .update({ snoozed_until: untilIso, updated_at: new Date().toISOString() })
          .eq("id", id);

        if (error) return serverError(error.message);
        return jsonCors(req, { success: true });
      }

      // resolve
      const resolveMethod = body.method as string | undefined;
      if (!resolveMethod) return badRequest("method is required");

      const { error: resolveErr } = await supabaseAdmin
        .from("owner_tasks")
        .update({
          resolved_at: new Date().toISOString(),
          resolved_by: ctx.userId,
          resolution: { method: resolveMethod, note: (body.note as string | undefined) ?? null },
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      if (resolveErr) return serverError(resolveErr.message);

      // If the task is linked to an appointment, update commission_paid_at
      if (taskRow.ref_type === "appointment" && taskRow.ref_id) {
        await supabaseAdmin
          .from("appointments")
          .update({
            commission_paid_at: new Date().toISOString(),
            commission_pay_method: resolveMethod,
          })
          .eq("id", taskRow.ref_id)
          .is("commission_paid_at", null);
      }

      return jsonCors(req, { success: true });
    }

    return badRequest("Method not allowed");
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("owner-tasks error:", e);
    return serverError("Unexpected error");
  }
}));
