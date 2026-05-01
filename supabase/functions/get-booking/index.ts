import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("get-booking", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET") {
    return badRequest("Only GET is allowed");
  }

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const bookingRef = url.searchParams.get("booking_reference");

    if (!id && !bookingRef) {
      return badRequest("Missing required query parameter: id or booking_reference");
    }

    const baseQuery = supabaseAdmin
      .from("appointments")
      .select(`
        id, business_id, client_id, staff_profile_id, service_id,
        status, starts_at, ends_at, price, deposit_amount,
        booking_reference, booking_source, notes,
        client:clients(first_name, last_name, email, phone),
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
      return notFound("Booking not found");
    }

    return new Response(JSON.stringify({ booking }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });
  } catch (err) {
    console.error("get-booking error:", err);
    return serverError("Failed to fetch booking");
  }
}));
