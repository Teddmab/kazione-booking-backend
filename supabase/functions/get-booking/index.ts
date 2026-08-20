import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { checkRateLimit } from "../_shared/rateLimit.ts";
import { verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";
import { verifyCancelToken } from "../_shared/bookingCancelToken.ts";

// Same generic 404 for "doesn't exist" AND "exists but the caller isn't
// authorized to see it" — prevents this endpoint being used to enumerate
// valid booking ids/references (with or without a throwaway account),
// mirroring the pattern lookup-booking already uses for wrong-email guesses.
const BOOKING_NOT_FOUND = "Booking not found";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("get-booking", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET") {
    return badRequest("Only GET is allowed");
  }

  // 60 requests / 5 min per IP — generous enough for BookingDetail's 3s
  // status-polling while a payment is pending, while still bounding a
  // scripted scan of the booking_reference space.
  const rateLimited = checkRateLimit(req, 60, 300_000);
  if (rateLimited) return rateLimited;

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const bookingRef = url.searchParams.get("booking_reference");
    const cancelToken = url.searchParams.get("cancel_token");

    if (!id && !bookingRef) {
      return badRequest("Missing required query parameter: id or booking_reference");
    }

    const baseQuery = supabaseAdmin
      .from("appointments")
      .select(`
        id, business_id, client_id, staff_profile_id, service_id,
        status, starts_at, ends_at, price, deposit_amount,
        booking_reference, booking_source, notes,
        client:clients(user_id, first_name, last_name, email, phone),
        service:services(name),
        staff:staff_profiles(display_name, avatar_url),
        business:businesses(name, country)
      `);

    const filteredQuery = id
      ? baseQuery.eq("id", id)
      : baseQuery.eq("booking_reference", bookingRef!);

    const { data: booking, error } = await filteredQuery.maybeSingle();
    if (error) {
      console.error("get-booking query error:", error);
      return serverError("Failed to fetch booking");
    }

    if (!booking) {
      return notFound(BOOKING_NOT_FOUND);
    }

    // ── Authorize ────────────────────────────────────────────────────────
    // Any one of:
    //  (a) a valid signed cancel token for this exact booking — the guest
    //      email-link flow, where "the link acts as auth";
    //  (b) the caller is the booking's own client (user_id match);
    //  (c) the caller is an active member of the booking's business
    //      (owner/manager/staff).
    let authorized = false;

    if (cancelToken) {
      const payload = await verifyCancelToken(cancelToken);
      authorized = !!payload &&
        (payload.aid === booking.id || payload.br === booking.booking_reference);
    }

    if (!authorized) {
      try {
        const user = await verifyAuth(req);
        const client = booking.client as unknown as { user_id: string | null } | null;
        if (client?.user_id && client.user_id === user.id) {
          authorized = true;
        } else {
          await verifyBusinessMember(user.id, booking.business_id as string);
          authorized = true;
        }
      } catch {
        authorized = false;
      }
    }

    if (!authorized) {
      return notFound(BOOKING_NOT_FOUND);
    }

    return new Response(JSON.stringify({ booking }), {
      headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    console.error("get-booking error:", err);
    return serverError("Failed to fetch booking");
  }
}));
