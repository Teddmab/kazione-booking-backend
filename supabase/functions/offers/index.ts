import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type OfferType = "appointment_discount" | "package" | "training" | "gift_voucher";

interface CreateOfferBody {
  business_id: string;
  type: OfferType;
  title: string;
  description?: string;
  // appointment_discount
  discount_type?: "percentage" | "fixed_amount";
  discount_value?: number;
  applies_to_services?: string[];
  // package / training / gift_voucher
  price?: number;
  currency_code?: string;
  sessions_total?: number;
  // validity
  valid_from?: string;
  valid_until?: string;
  max_redemptions?: number;
}

interface SellBody {
  business_id: string;
  offer_id: string;
  client_id?: string;
  amount_paid?: number;
  payment_id?: string;
  bank_transaction_id?: string;
  notes?: string;
}

interface UseBody {
  business_id: string;
  redemption_id: string;
  appointment_id?: string;
  amount?: number; // for gift_voucher: how much of the balance to apply
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(withLogging("offers", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url    = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action") ?? undefined;
  const id     = url.searchParams.get("id") ?? undefined;

  try {
    // ── GET /offers?business_id= — list active offer catalog ─────────────────
    if (method === "GET" && !action) {
      const businessId  = url.searchParams.get("business_id");
      const includeAll  = url.searchParams.get("include_inactive") === "true";

      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      let query = supabaseAdmin
        .from("business_offers")
        .select("*")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });

      if (!includeAll) query = query.eq("is_active", true);

      const { data, error } = await query;
      if (error) return serverError(req, error.message);
      return jsonCors(req, { offers: data ?? [] });
    }

    // ── GET /offers?action=redemptions&business_id= — list redemptions ────────
    if (method === "GET" && action === "redemptions") {
      const businessId = url.searchParams.get("business_id");
      const clientId   = url.searchParams.get("client_id") ?? undefined;
      const status     = url.searchParams.get("status") ?? undefined;

      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      let query = supabaseAdmin
        .from("offer_redemptions")
        .select(`
          *,
          business_offers ( id, type, title, description, sessions_total, price, currency_code ),
          clients ( id, first_name, last_name, email, phone )
        `)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });

      if (clientId) query = query.eq("client_id", clientId);
      if (status)   query = query.eq("status", status);

      const { data, error } = await query;
      if (error) return serverError(req, error.message);
      return jsonCors(req, { redemptions: data ?? [] });
    }

    // ── POST /offers — create offer template ──────────────────────────────────
    if (method === "POST" && !action) {
      const body = await req.json().catch(() => null) as CreateOfferBody | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, type, title } = body;
      if (!business_id) return badRequest(req, "business_id is required");
      if (!type)        return badRequest(req, "type is required");
      if (!title?.trim()) return badRequest(req, "title is required");

      const validTypes: OfferType[] = ["appointment_discount", "package", "training", "gift_voucher"];
      if (!validTypes.includes(type)) {
        return badRequest(req, `type must be one of: ${validTypes.join(", ")}`);
      }

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      // Type-specific validation
      if (type === "appointment_discount") {
        if (!body.discount_type)
          return badRequest(req, "discount_type is required for appointment_discount");
        if (body.discount_value == null || body.discount_value <= 0)
          return badRequest(req, "discount_value must be > 0 for appointment_discount");
        if (body.discount_type === "percentage" && body.discount_value > 100)
          return badRequest(req, "discount_value cannot exceed 100 for percentage discounts");
      }

      if (type === "package" || type === "training") {
        if (!body.sessions_total || body.sessions_total < 1)
          return badRequest(req, "sessions_total must be at least 1 for package/training");
      }

      if (type !== "appointment_discount" && (body.price == null || body.price < 0)) {
        return badRequest(req, "price is required for package, training, and gift_voucher offers");
      }

      const row = {
        business_id,
        type,
        title:                title.trim(),
        description:          body.description?.trim() ?? null,
        discount_type:        body.discount_type        ?? null,
        discount_value:       body.discount_value       ?? null,
        applies_to_services:  body.applies_to_services  ?? [],
        price:                body.price                ?? null,
        currency_code:        body.currency_code        ?? "EUR",
        sessions_total:       body.sessions_total       ?? null,
        valid_from:           body.valid_from           ?? null,
        valid_until:          body.valid_until          ?? null,
        max_redemptions:      body.max_redemptions      ?? null,
        is_active:            true,
      };

      const { data, error } = await supabaseAdmin
        .from("business_offers")
        .insert(row)
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { offer: data }, 201);
    }

    // ── POST /offers?action=sell — sell an offer to a client ──────────────────
    if (method === "POST" && action === "sell") {
      const body = await req.json().catch(() => null) as SellBody | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, offer_id } = body;
      if (!business_id) return badRequest(req, "business_id is required");
      if (!offer_id)    return badRequest(req, "offer_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      // Fetch the offer template
      const { data: offer, error: offerErr } = await supabaseAdmin
        .from("business_offers")
        .select("*")
        .eq("id", offer_id)
        .eq("business_id", business_id)
        .single();

      if (offerErr || !offer) return notFound(req, "Offer not found");
      if (!offer.is_active)   return badRequest(req, "Offer is no longer active");

      // Validity window check
      const today = new Date().toISOString().slice(0, 10);
      if (offer.valid_from && today < offer.valid_from)
        return badRequest(req, "Offer is not yet valid");
      if (offer.valid_until && today > offer.valid_until)
        return badRequest(req, "Offer has expired");

      // Max redemptions check
      if (offer.max_redemptions != null) {
        const { count, error: cntErr } = await supabaseAdmin
          .from("offer_redemptions")
          .select("id", { count: "exact", head: true })
          .eq("offer_id", offer_id)
          .neq("status", "cancelled");
        if (cntErr) return serverError(req, cntErr.message);
        if ((count ?? 0) >= offer.max_redemptions)
          return badRequest(req, "This offer has reached its maximum number of redemptions");
      }

      // Build redemption row
      const redemptionRow: Record<string, unknown> = {
        offer_id,
        business_id,
        client_id:           body.client_id           ?? null,
        amount_paid:         body.amount_paid          ?? null,
        payment_id:          body.payment_id           ?? null,
        bank_transaction_id: body.bank_transaction_id  ?? null,
        notes:               body.notes               ?? null,
        status:              body.amount_paid != null || body.payment_id != null || body.bank_transaction_id != null
                               ? "active"
                               : "pending",
        // Copy session count from offer template
        sessions_total:  offer.sessions_total ?? null,
        sessions_used:   0,
        // Gift voucher: initial balance = offer price
        voucher_value:   offer.type === "gift_voucher" ? offer.price : null,
        voucher_used:    0,
      };

      const { data, error } = await supabaseAdmin
        .from("offer_redemptions")
        .insert(redemptionRow)
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { redemption: data }, 201);
    }

    // ── POST /offers?action=use — use a session / apply voucher ───────────────
    // Links the redemption to an appointment, decrements sessions or balance.
    if (method === "POST" && action === "use") {
      const body = await req.json().catch(() => null) as UseBody | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, redemption_id, appointment_id } = body;
      if (!business_id)   return badRequest(req, "business_id is required");
      if (!redemption_id) return badRequest(req, "redemption_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      // Fetch the redemption + its offer
      const { data: redemption, error: rErr } = await supabaseAdmin
        .from("offer_redemptions")
        .select("*, business_offers(type, sessions_total)")
        .eq("id", redemption_id)
        .eq("business_id", business_id)
        .single();

      if (rErr || !redemption) return notFound(req, "Redemption not found");
      if (redemption.status !== "active")
        return badRequest(req, `Redemption is ${redemption.status}, not active`);

      const offerType = redemption.business_offers?.type as OfferType;
      const updates: Record<string, unknown> = {};

      if (offerType === "appointment_discount") {
        // Discount offers are single-use — mark completed immediately
        updates.status = "completed";
        updates.completed_at = new Date().toISOString();
      } else if (offerType === "package" || offerType === "training") {
        const newUsed = Number(redemption.sessions_used) + 1;
        updates.sessions_used = newUsed;
        if (newUsed >= Number(redemption.sessions_total)) {
          updates.status = "completed";
          updates.completed_at = new Date().toISOString();
        }
      } else if (offerType === "gift_voucher") {
        const balance  = Number(redemption.voucher_value) - Number(redemption.voucher_used);
        const applyAmt = body.amount != null
          ? Math.min(body.amount, balance)
          : balance;
        updates.voucher_used = Number(redemption.voucher_used) + applyAmt;
        if (Number(updates.voucher_used) >= Number(redemption.voucher_value)) {
          updates.status = "completed";
          updates.completed_at = new Date().toISOString();
        }
      }

      const { error: updErr } = await supabaseAdmin
        .from("offer_redemptions")
        .update(updates)
        .eq("id", redemption_id);
      if (updErr) return serverError(req, updErr.message);

      // Stamp the appointment if provided
      if (appointment_id) {
        const { error: apptErr } = await supabaseAdmin
          .from("appointments")
          .update({ offer_redemption_id: redemption_id })
          .eq("id", appointment_id)
          .eq("business_id", business_id);
        if (apptErr) return serverError(req, apptErr.message);
      }

      return jsonCors(req, {
        success: true,
        new_status:          updates.status ?? redemption.status,
        sessions_remaining:  offerType === "package" || offerType === "training"
          ? Number(redemption.sessions_total) - Number(updates.sessions_used ?? redemption.sessions_used)
          : null,
        voucher_remaining:   offerType === "gift_voucher"
          ? Number(redemption.voucher_value) - Number(updates.voucher_used ?? redemption.voucher_used)
          : null,
      });
    }

    // ── PATCH /offers?id= — update offer template ─────────────────────────────
    if (method === "PATCH" && id && !action) {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const allowed = [
        "title", "description", "is_active", "valid_from", "valid_until",
        "max_redemptions", "price", "discount_value", "applies_to_services",
      ];
      const patch: Record<string, unknown> = {};
      for (const key of allowed) {
        if (key in body) patch[key] = body[key];
      }

      if (Object.keys(patch).length === 0)
        return badRequest(req, "No updatable fields provided");

      const { data, error } = await supabaseAdmin
        .from("business_offers")
        .update(patch)
        .eq("id", id)
        .eq("business_id", businessId)
        .select()
        .single();

      if (error) return serverError(req, error.message);
      if (!data)  return notFound(req, "Offer not found");
      return jsonCors(req, { offer: data });
    }

    // ── PATCH /offers?action=payment&id= — update redemption payment ──────────
    // Used to link a bank transaction after the fact (bookkeeping reconciliation).
    if (method === "PATCH" && action === "payment" && id) {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const allowed = ["payment_id", "bank_transaction_id", "amount_paid", "status", "notes"];
      const patch: Record<string, unknown> = {};
      for (const key of allowed) {
        if (key in body) patch[key] = body[key];
      }

      // Auto-activate if a payment is being linked and status is pending
      if ((patch.payment_id || patch.bank_transaction_id) && !("status" in patch)) {
        const { data: existing } = await supabaseAdmin
          .from("offer_redemptions")
          .select("status")
          .eq("id", id)
          .eq("business_id", businessId)
          .single();
        if (existing?.status === "pending") patch.status = "active";
      }

      const { data, error } = await supabaseAdmin
        .from("offer_redemptions")
        .update(patch)
        .eq("id", id)
        .eq("business_id", businessId)
        .select()
        .single();

      if (error) return serverError(req, error.message);
      if (!data)  return notFound(req, "Redemption not found");
      return jsonCors(req, { redemption: data });
    }

    // ── DELETE /offers?id=&business_id= — deactivate offer ───────────────────
    if (method === "DELETE" && id) {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { error } = await supabaseAdmin
        .from("business_offers")
        .update({ is_active: false })
        .eq("id", id)
        .eq("business_id", businessId);

      if (error) return serverError(req, error.message);
      return jsonCors(req, { success: true });
    }

    return badRequest(req, "Unknown route");
  } catch (err) {
    console.error("offers error:", err);
    return serverError(req, "An unexpected error occurred");
  }
}));
