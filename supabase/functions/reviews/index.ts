import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, conflict, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth } from "../_shared/auth.ts";
import { getCallerIp } from "../_shared/adminAuth.ts";
import { logReviewModeration } from "../_shared/reviewAudit.ts";

const REVIEW_SELECT = `*, client:clients(first_name, last_name, avatar_url)`;

/**
 * /reviews — business reviews
 *
 * GET  ?business_id=&[page=&limit=]   → paginated business reviews (owner view)
 * GET  ?token=<token>                 → public: review form context (no auth)
 * POST body={token, rating, comment?, reviewer_name?}  → public token-based submit
 * POST body={appointmentId, rating, comment}           → authenticated customer submit
 * PATCH ?id=  body={reply}            → owner reply (owner/manager)
 * PATCH ?id=&action=moderate  body={is_public, reason}  → hide/unhide (owner/manager)
 */
Deno.serve(withLogging("reviews", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const id = url.searchParams.get("id");
  const token = url.searchParams.get("token");

  try {
    if (method === "GET") {
      // Public token-based: return form context (no auth required)
      if (token) {
        const { data: review, error } = await supabaseAdmin
          .from("reviews")
          .select(`
            id, review_token, token_used_at, appointment_id,
            appointment:appointments(
              booking_reference, starts_at,
              service:services(name),
              client:clients(first_name, last_name)
            ),
            business:businesses(name, logo_url, slug)
          `)
          .eq("review_token", token)
          .maybeSingle();

        if (error) return serverError(error.message);
        if (!review) return notFound("Review token not found");

        const r = review as Record<string, unknown>;
        if (r.token_used_at) {
          return jsonCors(req, { error: { code: "TOKEN_USED", message: "This review link has already been used" } }, 409);
        }

        const appt = r.appointment as Record<string, unknown> | null;
        const biz = r.business as Record<string, unknown> | null;
        const client = appt?.client as Record<string, string> | null;
        const service = appt?.service as Record<string, string> | null;

        return jsonCors(req, {
          salonName: biz?.name ?? null,
          salonLogoUrl: biz?.logo_url ?? null,
          clientName: client ? `${client.first_name} ${client.last_name}`.trim() : null,
          serviceName: service?.name ?? null,
          date: appt?.starts_at ?? null,
          reference: appt?.booking_reference ?? null,
        });
      }

      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id or token is required");

      const page = parseInt(url.searchParams.get("page") ?? "1", 10);
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const from = (page - 1) * limit;
      const staffProfileId = url.searchParams.get("staff_profile_id");

      // When filtering by staff member, do a two-step query:
      // 1. get appointment IDs for this staff, 2. filter reviews by those IDs
      let apptIdFilter: string[] | null = null;
      if (staffProfileId) {
        const { data: apptRows } = await supabaseAdmin
          .from("appointments")
          .select("id")
          .eq("business_id", businessId)
          .or(`staff_profile_id.eq.${staffProfileId},staff_profile_id_2.eq.${staffProfileId}`);
        apptIdFilter = (apptRows ?? []).map((r: { id: string }) => r.id);
      }

      let query = supabaseAdmin
        .from("reviews")
        .select(REVIEW_SELECT, { count: "exact" })
        .eq("business_id", businessId);

      if (apptIdFilter !== null) {
        if (apptIdFilter.length === 0) {
          return jsonCors(req, { reviews: [], total: 0 });
        }
        query = query.in("appointment_id", apptIdFilter);
      }

      const { data, error, count } = await query
        .order("created_at", { ascending: false })
        .range(from, from + limit - 1);

      if (error) return serverError(error.message);
      return jsonCors(req, { reviews: data ?? [], total: count ?? 0 });
    }

    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;

      // ── Public token-based review submission ────────────────────────────────
      if (body.token) {
        const tok = body.token as string;
        const rating = body.rating as number | undefined;
        const comment = body.comment as string | undefined;
        const reviewerName = body.reviewer_name as string | undefined;

        if (!rating || rating < 1 || rating > 5) return badRequest("rating must be 1–5");

        const { data: existing, error: fetchErr } = await supabaseAdmin
          .from("reviews")
          .select("id, token_used_at, appointment_id, business_id, client_id")
          .eq("review_token", tok)
          .maybeSingle();

        if (fetchErr) return serverError(fetchErr.message);
        if (!existing) return notFound("Review token not found");

        const ex = existing as Record<string, unknown>;
        if (ex.token_used_at) {
          return conflict("TOKEN_USED", "This review link has already been used");
        }

        const { data: updated, error: updateErr } = await supabaseAdmin
          .from("reviews")
          .update({
            rating,
            comment: comment ?? null,
            reviewer_name: reviewerName ?? null,
            token_used_at: new Date().toISOString(),
            is_public: true,
          })
          .eq("id", ex.id as string)
          .select(REVIEW_SELECT)
          .single();

        if (updateErr) return serverError(updateErr.message);
        return jsonCors(req, updated, 200);
      }

      // ── Authenticated customer review submission ─────────────────────────────
      const user = await verifyAuth(req);

      const appointmentId = body.appointmentId as string;
      if (!appointmentId) return badRequest("appointmentId is required");

      const { data: appt, error: apptErr } = await supabaseAdmin
        .from("appointments")
        .select("id, business_id, client_id, status, clients!inner(user_id)")
        .eq("id", appointmentId)
        .single();

      if (apptErr || !appt) return notFound("Appointment not found");

      const clientRef = (appt as Record<string, unknown>).clients as { user_id: string | null } | null;
      if (clientRef?.user_id !== user.id) {
        return forbidden("This appointment does not belong to you");
      }

      if ((appt as Record<string, unknown>).status !== "completed") {
        return badRequest("Reviews can only be submitted for completed appointments");
      }

      const { data: existingReview } = await supabaseAdmin
        .from("reviews")
        .select("id, review_token")
        .eq("appointment_id", appointmentId)
        .maybeSingle();

      if (existingReview) {
        // If a token-based row exists without a rating yet, allow auth customer to fill it
        const er = existingReview as Record<string, unknown>;
        if (er.review_token) {
          const { data: updated, error: updateErr } = await supabaseAdmin
            .from("reviews")
            .update({
              rating: body.rating,
              comment: body.comment ?? null,
              token_used_at: new Date().toISOString(),
              is_public: true,
            })
            .eq("id", er.id as string)
            .select(REVIEW_SELECT)
            .single();
          if (updateErr) return serverError(updateErr.message);
          return jsonCors(req, updated, 200);
        }
        return conflict("REVIEW_EXISTS", "A review already exists for this appointment");
      }

      const { data: review, error: insertErr } = await supabaseAdmin
        .from("reviews")
        .insert({
          business_id: (appt as Record<string, unknown>).business_id,
          client_id: (appt as Record<string, unknown>).client_id,
          appointment_id: appointmentId,
          rating: body.rating,
          comment: body.comment ?? null,
        })
        .select(REVIEW_SELECT)
        .single();

      if (insertErr) return serverError(insertErr.message);
      return jsonCors(req, review, 201);
    }

    if (method === "PATCH") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;
      const action = url.searchParams.get("action");

      const { data: existing } = await supabaseAdmin
        .from("reviews")
        .select("business_id")
        .eq("id", id)
        .single();

      if (!existing) return notFound("Review not found");

      const businessId = (existing as Record<string, unknown>).business_id as string;
      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      // ── Moderate: hide/unhide (owner/manager) ────────────────────────────
      if (action === "moderate") {
        const isPublic = body.is_public;
        const reason = body.reason as string | undefined;
        if (typeof isPublic !== "boolean") return badRequest("is_public (boolean) is required");
        if (!reason || !reason.trim()) return badRequest("reason is required");

        const { data, error } = await supabaseAdmin
          .from("reviews")
          .update({
            is_public: isPublic,
            moderated_by: ctx.userId,
            moderated_at: new Date().toISOString(),
            moderation_reason: reason,
          })
          .eq("id", id)
          .select(REVIEW_SELECT)
          .single();

        if (error) return serverError(error.message);

        logReviewModeration({
          businessId,
          reviewId: id,
          actorUserId: ctx.userId,
          action: isPublic ? "UNHIDDEN" : "HIDDEN",
          reason,
          ipAddress: getCallerIp(req),
        });

        return jsonCors(req, data);
      }

      // ── Reply (owner/manager) ─────────────────────────────────────────────
      const reply = body.reply as string;
      if (!reply) return badRequest("reply is required");

      const { data, error } = await supabaseAdmin
        .from("reviews")
        .update({ owner_reply: reply, replied_at: new Date().toISOString() })
        .eq("id", id)
        .select(REVIEW_SELECT)
        .single();

      if (error) return serverError(error.message);
      return jsonCors(req, data);
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("reviews error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
