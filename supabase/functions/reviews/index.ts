import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, conflict, forbidden, notFound, serverError, unauthorized } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const REVIEW_SELECT = `*, client:clients(first_name, last_name, avatar_url)`;

/**
 * /reviews — business reviews
 *
 * GET  ?business_id=&[page=&limit=]   → paginated business reviews
 * POST body={appointmentId, rating, comment}  → submit review (authenticated customer)
 * PATCH ?id=  body={reply}            → owner reply (owner/manager)
 */
Deno.serve(withLogging("reviews", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const id = url.searchParams.get("id");

  try {
    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      const page = parseInt(url.searchParams.get("page") ?? "1", 10);
      const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
      const from = (page - 1) * limit;

      const { data, error, count } = await supabaseAdmin
        .from("reviews")
        .select(REVIEW_SELECT, { count: "exact" })
        .eq("business_id", businessId)
        .order("created_at", { ascending: false })
        .range(from, from + limit - 1);

      if (error) return serverError(error.message);
      return json({ reviews: data ?? [], total: count ?? 0 });
    }

    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      const user = await verifyAuth(req);

      const appointmentId = body.appointmentId as string;
      if (!appointmentId) return badRequest("appointmentId is required");

      // Verify appointment belongs to this user via client record
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

      const { data: existing } = await supabaseAdmin
        .from("reviews")
        .select("id")
        .eq("appointment_id", appointmentId)
        .maybeSingle();

      if (existing) return conflict("REVIEW_EXISTS", "A review already exists for this appointment");

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
      return json(review, 201);
    }

    if (method === "PATCH") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;
      const reply = body.reply as string;
      if (!reply) return badRequest("reply is required");

      // Fetch review to get business_id for auth
      const { data: existing } = await supabaseAdmin
        .from("reviews")
        .select("business_id")
        .eq("id", id)
        .single();

      if (!existing) return notFound("Review not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const { data, error } = await supabaseAdmin
        .from("reviews")
        .update({ owner_reply: reply, replied_at: new Date().toISOString() })
        .eq("id", id)
        .select(REVIEW_SELECT)
        .single();

      if (error) return serverError(error.message);
      return json(data);
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("reviews error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
