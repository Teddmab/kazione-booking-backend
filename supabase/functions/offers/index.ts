import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx, verifyAuth } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";
import { offerAssignedEmail, sendEmail } from "../_shared/resend.ts";

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
    // ── GET /offers?action=catalog&business_id= — public: active offers for a business ──
    // No auth required — used by the client storefront page.
    if (method === "GET" && action === "catalog") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest(req, "business_id is required");

      const { data, error } = await supabaseAdmin
        .from("business_offers")
        .select("id, type, title, description, price, currency_code, sessions_total, discount_type, discount_value, applies_to_services, valid_from, valid_until, publish_status, target_audience")
        .eq("business_id", businessId)
        .eq("is_active", true)
        .eq("publish_status", "published")
        .in("target_audience", ["client", "both"])
        .order("created_at", { ascending: false });

      if (error) return serverError(req, error.message);
      return jsonCors(req, { offers: data ?? [] });
    }

    // ── GET /offers?action=verify-voucher&id= — public: scan QR to verify a redemption ──
    // No auth required — the UUID itself is unguessable and acts as an access token.
    if (method === "GET" && action === "verify-voucher") {
      if (!id) return badRequest(req, "id is required");

      const { data: row, error } = await supabaseAdmin
        .from("offer_redemptions")
        .select(`
          id, status, sessions_used, sessions_total,
          voucher_value, voucher_used, amount_paid, created_at, completed_at,
          offer:business_offers ( type, title, price, currency_code, sessions_total, discount_type, discount_value ),
          client:clients ( first_name ),
          business:businesses ( name )
        `)
        .eq("id", id)
        .maybeSingle();

      if (error) return serverError(req, error.message);
      if (!row) return notFound(req, "Voucher not found");

      const offer  = row.offer as unknown as { type: string; title: string; currency_code: string; sessions_total: number | null } | null;
      const client = row.client as unknown as { first_name: string } | null;
      const biz    = row.business as unknown as { name: string } | null;

      const balance_remaining =
        (row.voucher_value ?? 0) - (row.voucher_used ?? 0);
      const sessions_remaining =
        (row.sessions_total ?? 0) - (row.sessions_used ?? 0);

      return jsonCors(req, {
        voucher: {
          id:                  row.id,
          status:              row.status,
          offer_type:          offer?.type ?? null,
          offer_title:         offer?.title ?? null,
          currency_code:       offer?.currency_code ?? "EUR",
          business_name:       biz?.name ?? null,
          client_first_name:   client?.first_name ?? null,
          voucher_value:       row.voucher_value,
          voucher_used:        row.voucher_used,
          balance_remaining:   offer?.type === "gift_voucher" ? balance_remaining : null,
          sessions_total:      row.sessions_total,
          sessions_used:       row.sessions_used,
          sessions_remaining:  offer?.type === "package" || offer?.type === "training" ? sessions_remaining : null,
          issued_at:           row.created_at,
          completed_at:        row.completed_at,
        },
      });
    }

    // ── POST /offers?action=staff-redeem — staff: mark a voucher as fully used ──
    // Any business member (owner, manager, staff, receptionist) may call this.
    // Used from the staff "Scan Voucher" dialog.
    if (method === "POST" && action === "staff-redeem") {
      const user = await verifyAuth(req);
      const body = await req.json().catch(() => null) as { redemption_id: string; amount?: number } | null;
      if (!body?.redemption_id) return badRequest(req, "redemption_id is required");

      const { data: redemption, error: rErr } = await supabaseAdmin
        .from("offer_redemptions")
        .select(`
          id, status, business_id, sessions_total, sessions_used,
          voucher_value, voucher_used,
          offer:business_offers ( type )
        `)
        .eq("id", body.redemption_id)
        .maybeSingle();

      if (rErr) return serverError(req, rErr.message);
      if (!redemption) return notFound(req, "Voucher not found");
      if (redemption.status !== "active") return badRequest(req, `Voucher is ${redemption.status}, not active`);

      // Verify the caller is a member of this business (any role)
      const { data: member } = await supabaseAdmin
        .from("business_members")
        .select("role")
        .eq("user_id", user.id)
        .eq("business_id", redemption.business_id)
        .maybeSingle();

      if (!member) return forbidden(req, "Not a member of this business");

      const offer = redemption.offer as unknown as { type: string } | null;
      const now   = new Date().toISOString();

      let update: Record<string, unknown> = { status: "completed", completed_at: now };

      if (offer?.type === "gift_voucher") {
        const remaining = (redemption.voucher_value ?? 0) - (redemption.voucher_used ?? 0);
        const toUse     = Math.min(body.amount ?? remaining, remaining);
        update = { voucher_used: (redemption.voucher_used ?? 0) + toUse, status: "completed", completed_at: now };
      } else if (offer?.type === "package" || offer?.type === "training") {
        update = { sessions_used: redemption.sessions_total ?? 0, status: "completed", completed_at: now };
      }

      const { error: uErr } = await supabaseAdmin
        .from("offer_redemptions")
        .update(update)
        .eq("id", body.redemption_id);

      if (uErr) return serverError(req, uErr.message);
      return jsonCors(req, { success: true });
    }

    // ── POST /offers?action=buy — client: self-purchase any active offer ────────
    // Signed-in clients can buy packages, vouchers, and discounts.
    // Auto-creates a client profile if the user doesn't have one yet (same as training register).
    // Free offers / appointment_discount → status = active immediately.
    // Paid offers (package, gift_voucher) → status = pending until owner confirms payment.
    if (method === "POST" && action === "buy") {
      const body = await req.json().catch(() => null) as { offer_id: string; notes?: string } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { offer_id, notes } = body;
      if (!offer_id) return badRequest(req, "offer_id is required");

      const user = await verifyAuth(req);

      // Fetch the active offer (no business_id in body — derived from offer row)
      const { data: offer } = await supabaseAdmin
        .from("business_offers")
        .select("id, type, business_id, price, sessions_total, discount_type, discount_value, valid_from, valid_until, max_redemptions")
        .eq("id", offer_id)
        .eq("is_active", true)
        .maybeSingle();

      if (!offer) return notFound(req, "Offer not found or not available");

      // Date validity check
      const today = new Date().toISOString().slice(0, 10);
      if (offer.valid_from && today < offer.valid_from)
        return badRequest(req, "This offer is not yet available");
      if (offer.valid_until && today > offer.valid_until)
        return badRequest(req, "This offer has expired");

      // Max redemptions check
      if (offer.max_redemptions != null) {
        const { count } = await supabaseAdmin
          .from("offer_redemptions")
          .select("id", { count: "exact", head: true })
          .eq("offer_id", offer_id)
          .neq("status", "cancelled");
        if ((count ?? 0) >= offer.max_redemptions)
          return badRequest(req, "This offer is no longer available — all spots have been filled");
      }

      // Resolve or auto-create client (same pattern as training/register)
      let clientRow: { id: string } | null = null;

      const { data: byUserId } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("user_id", user.id)
        .eq("business_id", offer.business_id)
        .maybeSingle();

      clientRow = byUserId ?? null;

      if (!clientRow && user.email) {
        const { data: byEmail } = await supabaseAdmin
          .from("clients")
          .select("id")
          .eq("business_id", offer.business_id)
          .eq("email", user.email)
          .maybeSingle();
        if (byEmail) {
          await supabaseAdmin.from("clients").update({ user_id: user.id }).eq("id", byEmail.id);
          clientRow = byEmail;
        }
      }

      if (!clientRow) {
        const meta = (user.user_metadata ?? {}) as Record<string, string>;
        const firstName = (meta.first_name ?? meta.given_name ?? "").trim() || (user.email?.split("@")[0] ?? "Client");
        const lastName  = (meta.last_name  ?? meta.family_name ?? "").trim() || "";
        const { data: newClient, error: clientErr } = await supabaseAdmin
          .from("clients")
          .insert({ business_id: offer.business_id, user_id: user.id, first_name: firstName, last_name: lastName, email: user.email ?? null, source: "marketplace" })
          .select("id")
          .single();
        if (clientErr) return serverError(req, `Failed to create client profile: ${clientErr.message}`);
        clientRow = newClient;
      }

      // Check for existing active / pending redemption (prevent accidental duplicates)
      const { data: existing } = await supabaseAdmin
        .from("offer_redemptions")
        .select("id, status")
        .eq("offer_id", offer_id)
        .eq("client_id", clientRow.id)
        .in("status", ["active", "pending"])
        .maybeSingle();

      if (existing) {
        return jsonCors(req, { redemption_id: existing.id, status: existing.status, already_purchased: true });
      }

      // appointment_discount is always free (no currency transaction); gift_voucher and
      // package with price=0 are also free → activate immediately.
      const isFree = offer.type === "appointment_discount" || offer.price === null || offer.price === 0;
      const status = isFree ? "active" : "pending";

      const { data: redemption, error: rErr } = await supabaseAdmin
        .from("offer_redemptions")
        .insert({
          offer_id,
          client_id:      clientRow.id,
          business_id:    offer.business_id,
          status,
          sessions_total: (offer.type === "package" || offer.type === "training") ? offer.sessions_total : null,
          sessions_used:  0,
          voucher_value:  offer.type === "gift_voucher" ? offer.price : null,
          voucher_used:   0,
          notes:          notes ?? null,
        })
        .select("id, status")
        .single();

      if (rErr) return serverError(req, rErr.message);

      return jsonCors(req, { redemption_id: redemption.id, status: redemption.status, already_purchased: false }, 201);
    }

    // ── GET /offers?action=my-redemptions — client: list own redemptions ──────
    if (method === "GET" && action === "my-redemptions") {
      const user = await verifyAuth(req);

      const { data: clientRows } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("user_id", user.id);

      if (!clientRows || clientRows.length === 0) return jsonCors(req, { redemptions: [] });
      const clientIds = clientRows.map((c) => c.id);

      const { data, error } = await supabaseAdmin
        .from("offer_redemptions")
        .select(`
          id, offer_id, status, sessions_used, sessions_total,
          voucher_value, voucher_used, amount_paid, created_at, completed_at,
          offer:business_offers ( id, type, title, description, price, currency_code, sessions_total, discount_type, discount_value, applies_to_services ),
          business:businesses ( name )
        `)
        .in("client_id", clientIds)
        .order("created_at", { ascending: false });

      if (error) return serverError(req, error.message);
      return jsonCors(req, { redemptions: data ?? [] });
    }

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
      const offerId    = url.searchParams.get("offer_id")  ?? undefined;
      const status     = url.searchParams.get("status") ?? undefined;

      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      let query = supabaseAdmin
        .from("offer_redemptions")
        .select(`
          *,
          business_offers ( id, type, title, description, sessions_total, price, currency_code, discount_type, discount_value ),
          clients ( id, first_name, last_name, email, phone )
        `)
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });

      if (clientId) query = query.eq("client_id", clientId);
      if (offerId)  query = query.eq("offer_id", offerId);
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

      // Validity window and max_redemptions are marketplace restrictions.
      // Owners bypass both — they can sell any active offer to any client directly.

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

      // Fire-and-forget: notify the client by email
      if (body.client_id) {
        const [clientRes, bizRes] = await Promise.all([
          supabaseAdmin.from("clients").select("email, first_name, last_name").eq("id", body.client_id).maybeSingle(),
          supabaseAdmin.from("businesses").select("name, logo_url").eq("id", business_id).maybeSingle(),
        ]);
        const clientEmail = clientRes.data?.email as string | null ?? null;
        if (clientEmail) {
          const clientName = `${clientRes.data?.first_name ?? ""} ${clientRes.data?.last_name ?? ""}`.trim() || "Client";
          const salonName = bizRes.data?.name as string ?? "Your salon";
          const descMap: Record<OfferType, string> = {
            appointment_discount: offer.discount_type === "percentage" ? `${offer.discount_value}% off your next visit` : `€${Number(offer.discount_value ?? 0).toFixed(2)} off your next visit`,
            package: `${offer.sessions_total} session package`,
            training: `${offer.sessions_total} training session${(offer.sessions_total ?? 1) > 1 ? "s" : ""}`,
            gift_voucher: `€${Number(offer.price ?? 0).toFixed(2)} gift voucher`,
          };
          const emailData = offerAssignedEmail({
            clientName,
            salonName,
            salonLogoUrl: bizRes.data?.logo_url as string | null ?? null,
            offerName: offer.title as string,
            offerDescription: descMap[offer.type as OfferType] ?? "",
            expiresAt: offer.valid_until ?? null,
          });
          sendEmail(clientEmail, emailData.subject, emailData.html).catch(
            (err) => console.error("Offer assignment email failed:", err),
          );
        }
      }

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

      // Fetch the redemption + its offer (include discount fields for appointment_discount type)
      const { data: redemption, error: rErr } = await supabaseAdmin
        .from("offer_redemptions")
        .select("*, business_offers(type, sessions_total, discount_type, discount_value)")
        .eq("id", redemption_id)
        .eq("business_id", business_id)
        .single();

      if (rErr || !redemption) return notFound(req, "Redemption not found");
      if (redemption.status !== "active")
        return badRequest(req, `Redemption is ${redemption.status}, not active`);

      const offerType = redemption.business_offers?.type as OfferType;
      const updates: Record<string, unknown> = {};
      let offerDiscount: number | null = null;

      if (offerType === "appointment_discount") {
        // Discount offers are single-use — mark completed immediately
        updates.status = "completed";
        updates.completed_at = new Date().toISOString();
        // Compute the monetary discount against the appointment price
        if (appointment_id) {
          const { data: apptRow } = await supabaseAdmin
            .from("appointments")
            .select("price")
            .eq("id", appointment_id)
            .eq("business_id", business_id)
            .single();
          const apptPrice = Number((apptRow as { price?: number } | null)?.price ?? 0);
          const dType  = (redemption.business_offers as Record<string, unknown>)?.discount_type as string | null;
          const dValue = Number((redemption.business_offers as Record<string, unknown>)?.discount_value ?? 0);
          offerDiscount = dType === "percentage"
            ? +(apptPrice * dValue / 100).toFixed(2)
            : Math.min(dValue, apptPrice);
        }
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
        offerDiscount = +applyAmt.toFixed(2);
      }

      const { error: updErr } = await supabaseAdmin
        .from("offer_redemptions")
        .update(updates)
        .eq("id", redemption_id);
      if (updErr) return serverError(req, updErr.message);

      // Stamp the appointment if provided
      if (appointment_id) {
        const apptStamp: Record<string, unknown> = { offer_redemption_id: redemption_id };
        if (offerDiscount !== null) apptStamp.offer_discount = offerDiscount;
        const { error: apptErr } = await supabaseAdmin
          .from("appointments")
          .update(apptStamp)
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
        "max_redemptions", "price", "discount_value", "discount_type",
        "sessions_total", "applies_to_services",
        "publish_status", "target_audience",
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

      const allowed = ["payment_id", "bank_transaction_id", "amount_paid", "payment_method", "status", "notes"];
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

    // ── POST /offers?action=remove-from-appointment ───────────────────────────
    if (method === "POST" && action === "remove-from-appointment") {
      const body = await req.json().catch(() => null) as {
        business_id?: string;
        redemption_id?: string;
        appointment_id?: string;
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");
      const { business_id, redemption_id, appointment_id } = body;
      if (!business_id)   return badRequest(req, "business_id is required");
      if (!redemption_id) return badRequest(req, "redemption_id is required");
      if (!appointment_id) return badRequest(req, "appointment_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      // Verify appointment belongs to this business and get offer_discount for voucher reversal
      const { data: apptRow } = await supabaseAdmin
        .from("appointments")
        .select("id, offer_discount")
        .eq("id", appointment_id)
        .eq("business_id", business_id)
        .single();
      if (!apptRow) return notFound(req, "Appointment not found");
      const offerDiscount = Number((apptRow as Record<string, unknown>).offer_discount ?? 0);

      // Get the redemption + offer type
      const { data: redemption, error: rErr } = await supabaseAdmin
        .from("offer_redemptions")
        .select("*, business_offers(type, sessions_total, voucher_value)")
        .eq("id", redemption_id)
        .eq("business_id", business_id)
        .single();
      if (rErr || !redemption) return notFound(req, "Redemption not found");

      const offerType = (redemption.business_offers as Record<string, unknown> | null)?.type as string | undefined;
      const reversal: Record<string, unknown> = {};

      if (offerType === "appointment_discount") {
        reversal.status = "active";
        reversal.completed_at = null;
      } else if (offerType === "package" || offerType === "training") {
        const newUsed = Math.max(0, Number(redemption.sessions_used) - 1);
        reversal.sessions_used = newUsed;
        const sessionsTotal = Number((redemption.business_offers as Record<string, unknown>)?.sessions_total ?? 0);
        if (sessionsTotal > newUsed) {
          reversal.status = "active";
          reversal.completed_at = null;
        }
      } else if (offerType === "gift_voucher") {
        const newVoucherUsed = Math.max(0, Number(redemption.voucher_used) - offerDiscount);
        reversal.voucher_used = +newVoucherUsed.toFixed(2);
        const voucherValue = Number((redemption.business_offers as Record<string, unknown>)?.voucher_value ?? 0);
        if (voucherValue > newVoucherUsed) {
          reversal.status = "active";
          reversal.completed_at = null;
        }
      }

      if (Object.keys(reversal).length > 0) {
        const { error: updErr } = await supabaseAdmin
          .from("offer_redemptions")
          .update(reversal)
          .eq("id", redemption_id);
        if (updErr) return serverError(req, updErr.message);
      }

      await supabaseAdmin
        .from("appointments")
        .update({ offer_redemption_id: null, offer_discount: null })
        .eq("id", appointment_id)
        .eq("business_id", business_id);

      return jsonCors(req, { success: true });
    }

    return badRequest(req, "Unknown route");
  } catch (err) {
    console.error("offers error:", err);
    return serverError(req, "An unexpected error occurred");
  }
}));
