import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";

const VALID_CATEGORIES = ["rent", "electricity", "water", "internet_phone", "insurance", "maintenance", "other"];
const VALID_FREQUENCIES = ["monthly", "quarterly", "annual", "one_off"];

/**
 * /fixed-costs — recurring and one-off operating expenses (rent, utilities, etc.)
 *
 * GET  ?business_id=&[from=&to=]         → list with optional date range
 * GET  ?action=summary&business_id=      → totals by category for current month
 * POST body={business_id,...}            → create fixed cost entry
 * PATCH ?id=  body={...fields}           → update
 * DELETE ?id=                            → delete
 */
Deno.serve(withLogging("fixed-costs", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const id = url.searchParams.get("id");
  const action = url.searchParams.get("action");

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      try {
        const user = await verifyAuth(req);
        await verifyBusinessMember(user.id, businessId);
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }

      if (action === "summary") {
        // Totals by category for the last 12 months
        const today = new Date();
        const from = new Date(today.getFullYear(), today.getMonth() - 11, 1).toISOString().slice(0, 10);

        const { data, error } = await supabaseAdmin
          .from("fixed_costs")
          .select("category, amount, frequency, cost_date")
          .eq("business_id", businessId)
          .gte("cost_date", from)
          .order("cost_date", { ascending: false });

        if (error) return serverError(error.message);

        const byCategory: Record<string, number> = {};
        const byMonth: Record<string, number> = {};

        for (const row of data ?? []) {
          const r = row as Record<string, unknown>;
          const amt = Number(r.amount);
          const cat = r.category as string;
          const month = (r.cost_date as string).slice(0, 7);
          byCategory[cat] = (byCategory[cat] ?? 0) + amt;
          byMonth[month] = (byMonth[month] ?? 0) + amt;
        }

        const monthlySeries = Object.entries(byMonth)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([month, total]) => ({ month, total }));

        return jsonCors(req, { by_category: byCategory, monthly_series: monthlySeries });
      }

      // Default: list
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");

      // deno-lint-ignore no-explicit-any
      let query: any = supabaseAdmin
        .from("fixed_costs")
        .select("*")
        .eq("business_id", businessId)
        .order("cost_date", { ascending: false });

      if (from) query = query.gte("cost_date", from);
      if (to) query = query.lte("cost_date", to);

      const { data, error } = await query;
      if (error) return serverError(error.message);
      return jsonCors(req, { costs: data ?? [] });
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
      if (ctx instanceof Response) return ctx;

      const name = String(body.name ?? "").trim();
      if (!name) return badRequest("name is required");

      const category = String(body.category ?? "").trim();
      if (!VALID_CATEGORIES.includes(category)) {
        return badRequest(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);
      }

      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) return badRequest("amount must be a non-negative number");

      const frequency = String(body.frequency ?? "monthly").trim();
      if (!VALID_FREQUENCIES.includes(frequency)) {
        return badRequest(`frequency must be one of: ${VALID_FREQUENCIES.join(", ")}`);
      }

      const costDate = String(body.cost_date ?? body.date ?? "").trim();
      if (!costDate || !/^\d{4}-\d{2}-\d{2}$/.test(costDate)) {
        return badRequest("cost_date must be YYYY-MM-DD");
      }

      const { data, error } = await supabaseAdmin
        .from("fixed_costs")
        .insert({
          business_id: ctx.businessId,
          name,
          category,
          amount,
          currency_code: String(body.currency_code ?? "EUR"),
          frequency,
          cost_date: costDate,
          is_tax_deductible: body.is_tax_deductible !== false,
          notes: body.notes ? String(body.notes).trim() : null,
        })
        .select()
        .single();

      if (error) return serverError(error.message);
      return jsonCors(req, data, 201);
    }

    // ── PATCH ──────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (!id) return badRequest("id is required");

      const { data: existing } = await supabaseAdmin
        .from("fixed_costs")
        .select("business_id")
        .eq("id", id)
        .single();
      if (!existing) return notFound("Fixed cost entry not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const body = await req.json() as Record<string, unknown>;
      const updatePayload: Record<string, unknown> = {};

      if (body.name !== undefined) updatePayload.name = String(body.name).trim();
      if (body.category !== undefined) {
        if (!VALID_CATEGORIES.includes(String(body.category))) {
          return badRequest(`category must be one of: ${VALID_CATEGORIES.join(", ")}`);
        }
        updatePayload.category = body.category;
      }
      if (body.amount !== undefined) updatePayload.amount = Number(body.amount);
      if (body.frequency !== undefined) {
        if (!VALID_FREQUENCIES.includes(String(body.frequency))) {
          return badRequest(`frequency must be one of: ${VALID_FREQUENCIES.join(", ")}`);
        }
        updatePayload.frequency = body.frequency;
      }
      if (body.cost_date !== undefined) updatePayload.cost_date = body.cost_date;
      if (body.currency_code !== undefined) updatePayload.currency_code = body.currency_code;
      if (body.is_tax_deductible !== undefined) updatePayload.is_tax_deductible = Boolean(body.is_tax_deductible);
      if (body.notes !== undefined) updatePayload.notes = body.notes ? String(body.notes).trim() : null;
      if (body.paid_at !== undefined) updatePayload.paid_at = body.paid_at ? String(body.paid_at) : null;
      if (body.payment_method !== undefined) updatePayload.payment_method = body.payment_method ? String(body.payment_method).trim() : null;
      if (body.payment_proof_url !== undefined) updatePayload.payment_proof_url = body.payment_proof_url ? String(body.payment_proof_url) : null;
      // end_date: null clears (reactivates), string value sets the stop date
      if (body.end_date !== undefined) updatePayload.end_date = body.end_date ? String(body.end_date) : null;

      const { data, error } = await supabaseAdmin
        .from("fixed_costs")
        .update(updatePayload)
        .eq("id", id)
        .select()
        .single();

      if (error) return serverError(error.message);
      return jsonCors(req, data);
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    if (method === "DELETE") {
      if (!id) return badRequest("id is required");

      const { data: existing } = await supabaseAdmin
        .from("fixed_costs")
        .select("business_id")
        .eq("id", id)
        .single();
      if (!existing) return notFound("Fixed cost entry not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const { error } = await supabaseAdmin
        .from("fixed_costs")
        .delete()
        .eq("id", id);

      if (error) return serverError(error.message);
      return jsonCors(req, { ok: true });
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("fixed-costs error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
