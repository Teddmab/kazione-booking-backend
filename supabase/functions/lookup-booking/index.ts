import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// CustomerBooking interface — mirrors frontend src/data/bookingsData.ts
// ---------------------------------------------------------------------------

interface CustomerBookingService {
  id: string;
  name: string;
  duration: string;
  durationMinutes: number;
  price: number;
  currency: string;
}

interface CustomerBookingStaff {
  id: string;
  name: string;
  avatar: string | null;
}

interface CustomerBookingPayment {
  status: string;
  method: string;
  amount: number;
  currency: string;
  depositAmount: number;
  taxAmount: number;
  discountAmount: number;
  paidAt: string | null;
}

interface CustomerBookingSalon {
  name: string;
  slug: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  email: string | null;
}

interface CustomerBooking {
  id: string;
  bookingReference: string;
  status: string;
  date: string;
  time: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  price: number;
  depositAmount: number;
  notes: string | null;
  createdAt: string;
  service: CustomerBookingService;
  staff: CustomerBookingStaff;
  payment: CustomerBookingPayment | null;
  salon: CustomerBookingSalon;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hrs = minutes / 60;
  if (Number.isInteger(hrs)) return `${hrs} hrs`;
  return `${hrs.toFixed(1)} hrs`;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Returns true if strings are equal.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = new TextEncoder().encode(a);
  const bBuf = new TextEncoder().encode(b);

  if (aBuf.length !== bBuf.length) {
    // Still do a full comparison to avoid length-based timing leaks
    let result = 1;
    for (let i = 0; i < aBuf.length; i++) {
      result |= aBuf[i] ^ (bBuf[i % bBuf.length] ?? 0);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < aBuf.length; i++) {
    result |= aBuf[i] ^ bBuf[i];
  }
  return result === 0;
}

// Same generic 404 for not-found AND wrong email to prevent enumeration
const BOOKING_NOT_FOUND = "Booking not found";

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("lookup-booking", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "GET") {
    return badRequest("Only GET is allowed");
  }

  try {
    const url = new URL(req.url);
    const reference = url.searchParams.get("reference");
    const email = url.searchParams.get("email");

    if (!reference || !email) {
      return badRequest("Both 'reference' and 'email' query parameters are required");
    }

    // ── Find appointment by reference ─────────────────────────────────────
    const { data: appointment, error: apptErr } = await supabaseAdmin
      .from("appointments")
      .select(`
        id, business_id, client_id, staff_profile_id, service_id,
        status, starts_at, ends_at, duration_minutes, price,
        deposit_amount, booking_reference, booking_source,
        notes, created_at
      `)
      .eq("booking_reference", reference)
      .maybeSingle();

    if (apptErr) throw apptErr;
    if (!appointment) return notFound(BOOKING_NOT_FOUND);

    // ── Verify client email (constant-time) ───────────────────────────────
    const { data: client, error: clientErr } = await supabaseAdmin
      .from("clients")
      .select("email, first_name")
      .eq("id", appointment.client_id)
      .single();

    if (clientErr || !client) return notFound(BOOKING_NOT_FOUND);

    const clientEmail = (client.email ?? "").toLowerCase();
    const providedEmail = email.toLowerCase();

    if (!constantTimeEquals(clientEmail, providedEmail)) {
      return notFound(BOOKING_NOT_FOUND);
    }

    // ── Parallel fetch related data ───────────────────────────────────────
    const [serviceResult, staffResult, paymentResult, businessResult, storefrontResult] =
      await Promise.all([
        supabaseAdmin
          .from("services")
          .select("id, name, duration_minutes, price, currency_code")
          .eq("id", appointment.service_id)
          .single(),

        appointment.staff_profile_id
          ? supabaseAdmin
              .from("staff_profiles")
              .select("id, display_name, avatar_url")
              .eq("id", appointment.staff_profile_id)
              .single()
          : Promise.resolve({
              data: { id: null, display_name: "Any available", avatar_url: null },
              error: null,
            }),

        supabaseAdmin
          .from("payments")
          .select(
            "status, method, amount, currency_code, deposit_amount, tax_amount, discount_amount, paid_at",
          )
          .eq("appointment_id", appointment.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),

        supabaseAdmin
          .from("businesses")
          .select("name, slug, currency_code")
          .eq("id", appointment.business_id)
          .single(),

        supabaseAdmin
          .from("storefronts")
          .select("slug, address, city, phone, email")
          .eq("business_id", appointment.business_id)
          .maybeSingle(),
      ]);

    if (serviceResult.error) throw serviceResult.error;
    if (staffResult.error) throw staffResult.error;
    if (businessResult.error) throw businessResult.error;

    const svc = serviceResult.data!;
    const staff = staffResult.data!;
    const pay = paymentResult.data;
    const biz = businessResult.data!;
    const sf = storefrontResult.data;
    const currency = svc.currency_code ?? biz.currency_code ?? "EUR";

    const startsAt = new Date(appointment.starts_at);

    // ── Build response ────────────────────────────────────────────────────
    const response: CustomerBooking = {
      id: appointment.id,
      bookingReference: appointment.booking_reference,
      status: appointment.status,
      date: startsAt.toISOString().slice(0, 10),
      time: startsAt.toISOString().slice(11, 16),
      startsAt: appointment.starts_at,
      endsAt: appointment.ends_at,
      durationMinutes: appointment.duration_minutes,
      price: +appointment.price,
      depositAmount: +appointment.deposit_amount,
      notes: appointment.notes ?? null,
      createdAt: appointment.created_at,

      service: {
        id: svc.id,
        name: svc.name,
        duration: formatDuration(svc.duration_minutes),
        durationMinutes: svc.duration_minutes,
        price: +svc.price,
        currency,
      },

      staff: {
        id: staff.id ?? "",
        name: staff.display_name,
        avatar: staff.avatar_url ?? null,
      },

      payment: pay
        ? {
            status: pay.status,
            method: pay.method,
            amount: +pay.amount,
            currency: pay.currency_code ?? currency,
            depositAmount: +(pay.deposit_amount ?? 0),
            taxAmount: +pay.tax_amount,
            discountAmount: +pay.discount_amount,
            paidAt: pay.paid_at ?? null,
          }
        : null,

      salon: {
        name: biz.name,
        slug: sf?.slug ?? biz.slug,
        address: sf?.address ?? null,
        city: sf?.city ?? null,
        phone: sf?.phone ?? null,
        email: sf?.email ?? null,
      },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("lookup-booking error:", err);
    return serverError("Failed to look up booking");
  }
}));
