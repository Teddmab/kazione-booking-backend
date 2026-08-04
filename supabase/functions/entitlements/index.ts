import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type EntitlementType = "appointment_discount" | "package" | "training" | "gift_voucher";
type EntitlementStatus = "active" | "used" | "expired" | "cancelled";

interface CreateBody {
  business_id: string;
  client_id: string;
  type: EntitlementType;
  name: string;
  notes?: string;
  // appointment_discount
  discount_type?: "percentage" | "fixed";
  discount_value?: number;
  service_ids?: string[];
  // package / training
  total_sessions?: number;
  curriculum_text?: string;
  // gift_voucher
  original_value?: number;
  // payment
  price_paid?: number;
  payment_method?: string;
  payment_reference?: string;
  paid_at?: string;
  // validity
  expires_at?: string;
}

interface RedeemBody {
  business_id: string;
  entitlement_id: string;
  appointment_id: string;
  // for gift_voucher: how much of the balance to apply (defaults to full balance or appointment price, whichever is less)
  amount?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(withLogging("entitlements", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action") ?? undefined;
  const id = url.searchParams.get("id") ?? undefined;

  try {
    // ── GET /entitlements?business_id=&client_id= ─────────────────────────────
    // List all entitlements for a client. Includes redemption history.
    if (method === "GET" && !action) {
      const businessId = url.searchParams.get("business_id");
      const clientId   = url.searchParams.get("client_id");
      const status     = url.searchParams.get("status") ?? undefined; // optional filter

      if (!businessId) return badRequest(req, "business_id is required");
      if (!clientId)   return badRequest(req, "client_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      let query = supabaseAdmin
        .from("client_entitlements")
        .select(`
          *,
          entitlement_redemptions (
            id, appointment_id, amount_redeemed, discount_applied, notes, redeemed_at
          )
        `)
        .eq("business_id", businessId)
        .eq("client_id", clientId)
        .order("created_at", { ascending: false });

      if (status) query = query.eq("status", status);

      const { data, error } = await query;
      if (error) return serverError(req, error.message);

      return jsonCors(req, { entitlements: data ?? [] });
    }

    // ── GET /entitlements?action=list&business_id= ────────────────────────────
    // List all active entitlements for the business (for the owner overview).
    if (method === "GET" && action === "list") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { data, error } = await supabaseAdmin
        .from("client_entitlements")
        .select(`
          id, type, name, status, total_sessions, sessions_used,
          original_value, remaining_balance, expires_at, created_at,
          clients ( id, first_name, last_name, email, phone )
        `)
        .eq("business_id", businessId)
        .eq("status", "active")
        .order("created_at", { ascending: false });

      if (error) return serverError(req, error.message);
      return jsonCors(req, { entitlements: data ?? [] });
    }

    // ── POST /entitlements — Create (sell) a new entitlement ──────────────────
    if (method === "POST" && !action) {
      const body = await req.json().catch(() => null) as CreateBody | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, client_id, type, name } = body;
      if (!business_id) return badRequest(req, "business_id is required");
      if (!client_id)   return badRequest(req, "client_id is required");
      if (!type)        return badRequest(req, "type is required");
      if (!name)        return badRequest(req, "name is required");

      const validTypes: EntitlementType[] = [
        "appointment_discount", "package", "training", "gift_voucher",
      ];
      if (!validTypes.includes(type)) {
        return badRequest(req, `type must be one of: ${validTypes.join(", ")}`);
      }

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      // Type-specific validation
      if (type === "appointment_discount") {
        if (!body.discount_type)  return badRequest(req, "discount_type is required for appointment_discount");
        if (body.discount_value == null) return badRequest(req, "discount_value is required for appointment_discount");
        if (body.discount_type === "percentage" && (body.discount_value <= 0 || body.discount_value > 100)) {
          return badRequest(req, "discount_value must be between 1 and 100 for percentage discounts");
        }
      }

      if (type === "package" || type === "training") {
        if (!body.total_sessions || body.total_sessions < 1) {
          return badRequest(req, "total_sessions must be at least 1 for package/training");
        }
      }

      if (type === "gift_voucher") {
        if (!body.original_value || body.original_value <= 0) {
          return badRequest(req, "original_value must be greater than 0 for gift_voucher");
        }
      }

      const row = {
        business_id,
        client_id,
        type,
        name,
        status: "active" as EntitlementStatus,
        notes: body.notes ?? null,
        // discount
        discount_type:  body.discount_type  ?? null,
        discount_value: body.discount_value ?? null,
        service_ids:    body.service_ids    ?? null,
        // package/training
        total_sessions:  body.total_sessions  ?? null,
        sessions_used:   0,
        curriculum_text: body.curriculum_text ?? null,
        // gift voucher
        original_value:   body.original_value ?? null,
        remaining_balance: body.original_value ?? null, // starts at full value
        // payment
        price_paid:         body.price_paid         ?? null,
        payment_method:     body.payment_method     ?? null,
        payment_reference:  body.payment_reference  ?? null,
        paid_at:            body.paid_at            ?? null,
        // validity
        expires_at: body.expires_at ?? null,
      };

      const { data, error } = await supabaseAdmin
        .from("client_entitlements")
        .insert(row)
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { entitlement: data }, 201);
    }

    // ── POST /entitlements?action=redeem — Apply to an appointment ────────────
    if (method === "POST" && action === "redeem") {
      const body = await req.json().catch(() => null) as RedeemBody | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, entitlement_id, appointment_id } = body;
      if (!business_id)    return badRequest(req, "business_id is required");
      if (!entitlement_id) return badRequest(req, "entitlement_id is required");
      if (!appointment_id) return badRequest(req, "appointment_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      // Fetch the entitlement
      const { data: ent, error: entErr } = await supabaseAdmin
        .from("client_entitlements")
        .select("*")
        .eq("id", entitlement_id)
        .eq("business_id", business_id)
        .single();

      if (entErr || !ent) return notFound(req, "Entitlement not found");
      if (ent.status !== "active") {
        return badRequest(req, `Entitlement is ${ent.status}, not active`);
      }

      // Check expiry
      if (ent.expires_at && new Date(ent.expires_at) < new Date()) {
        await supabaseAdmin
          .from("client_entitlements")
          .update({ status: "expired" })
          .eq("id", entitlement_id);
        return badRequest(req, "Entitlement has expired");
      }

      // Fetch appointment to calculate discount
      const { data: appt, error: apptErr } = await supabaseAdmin
        .from("appointments")
        .select("id, price, service_id, client_id")
        .eq("id", appointment_id)
        .eq("business_id", business_id)
        .single();

      if (apptErr || !appt) return notFound(req, "Appointment not found");
      if (appt.client_id !== ent.client_id) {
        return badRequest(req, "Entitlement belongs to a different client");
      }

      // Check service scope for appointment_discount
      if (
        ent.type === "appointment_discount" &&
        ent.service_ids?.length > 0 &&
        !ent.service_ids.includes(appt.service_id)
      ) {
        return badRequest(req, "This discount does not apply to the selected service");
      }

      const apptPrice = Number(appt.price ?? 0);
      let discountApplied = 0;
      let amountRedeemed  = 0;
      let newStatus: EntitlementStatus | null = null;
      const updates: Record<string, unknown> = {};

      if (ent.type === "appointment_discount") {
        discountApplied = ent.discount_type === "percentage"
          ? +(apptPrice * Number(ent.discount_value) / 100).toFixed(2)
          : Math.min(Number(ent.discount_value), apptPrice);
        amountRedeemed = 1;
        newStatus = "used"; // one-time use
        updates.status = "used";
      }

      if (ent.type === "package" || ent.type === "training") {
        amountRedeemed = 1;
        const newUsed = Number(ent.sessions_used) + 1;
        updates.sessions_used = newUsed;
        if (newUsed >= Number(ent.total_sessions)) {
          newStatus = "used";
          updates.status = "used";
        }
      }

      if (ent.type === "gift_voucher") {
        const balance = Number(ent.remaining_balance);
        const applyAmount = body.amount != null
          ? Math.min(body.amount, balance, apptPrice)
          : Math.min(balance, apptPrice);
        discountApplied = +applyAmount.toFixed(2);
        amountRedeemed = discountApplied;
        const newBalance = +(balance - discountApplied).toFixed(2);
        updates.remaining_balance = newBalance;
        if (newBalance <= 0) {
          newStatus = "used";
          updates.status = "used";
        }
      }

      // Apply updates to entitlement in a transaction-like sequence
      if (Object.keys(updates).length > 0) {
        const { error: updErr } = await supabaseAdmin
          .from("client_entitlements")
          .update(updates)
          .eq("id", entitlement_id);
        if (updErr) return serverError(req, updErr.message);
      }

      // Log the redemption
      const { error: logErr } = await supabaseAdmin
        .from("entitlement_redemptions")
        .insert({
          entitlement_id,
          appointment_id,
          amount_redeemed:  amountRedeemed,
          discount_applied: discountApplied,
        });
      if (logErr) return serverError(req, logErr.message);

      // Stamp the appointment with the entitlement used
      const { error: apptUpdErr } = await supabaseAdmin
        .from("appointments")
        .update({
          entitlement_id,
          entitlement_discount: discountApplied || null,
        })
        .eq("id", appointment_id);
      if (apptUpdErr) return serverError(req, apptUpdErr.message);

      return jsonCors(req, {
        success: true,
        discount_applied: discountApplied,
        new_status: newStatus ?? ent.status,
        sessions_remaining: ent.total_sessions
          ? Number(ent.total_sessions) - (Number(ent.sessions_used) + 1)
          : null,
        balance_remaining: ent.type === "gift_voucher"
          ? Number(ent.remaining_balance) - discountApplied
          : null,
      });
    }

    // ── PATCH /entitlements?id= — Update (mark paid, cancel, edit notes) ──────
    if (method === "PATCH" && id) {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      // Only allow safe fields to be updated
      const allowed = [
        "status", "notes", "payment_method", "payment_reference",
        "paid_at", "price_paid", "expires_at", "name",
      ];
      const patch: Record<string, unknown> = {};
      for (const key of allowed) {
        if (key in body) patch[key] = body[key];
      }

      if (Object.keys(patch).length === 0) {
        return badRequest(req, "No updatable fields provided");
      }

      const { data, error } = await supabaseAdmin
        .from("client_entitlements")
        .update(patch)
        .eq("id", id)
        .eq("business_id", businessId)
        .select()
        .single();

      if (error) return serverError(req, error.message);
      if (!data) return notFound(req, "Entitlement not found");

      return jsonCors(req, { entitlement: data });
    }

    // ── DELETE /entitlements?id= — Cancel ─────────────────────────────────────
    if (method === "DELETE" && id) {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { error } = await supabaseAdmin
        .from("client_entitlements")
        .update({ status: "cancelled" })
        .eq("id", id)
        .eq("business_id", businessId);

      if (error) return serverError(req, error.message);
      return jsonCors(req, { success: true });
    }

    return badRequest(req, "Unknown route");
  } catch (err) {
    console.error("entitlements error:", err);
    return serverError(req, "An unexpected error occurred");
  }
}));
