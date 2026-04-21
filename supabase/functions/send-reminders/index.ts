import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, unauthorized, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { issueCancelToken } from "../_shared/bookingCancelToken.ts";

// ---------------------------------------------------------------------------
// Auth — CRON_SECRET header check
// ---------------------------------------------------------------------------

const CRON_SECRET = Deno.env.get("CRON_SECRET");

function verifyCronAuth(req: Request): boolean {
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ") || !CRON_SECRET) return false;

  const token = header.replace("Bearer ", "");
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(CRON_SECRET);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// Internal call to send-email function
// ---------------------------------------------------------------------------

const FUNCTIONS_URL = Deno.env.get("SUPABASE_URL") + "/functions/v1";
const INTERNAL_KEY = Deno.env.get("INTERNAL_FUNCTION_KEY")!;

async function sendEmailInternal(
  to: string,
  template: string,
  data: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${FUNCTIONS_URL}/send-email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-internal-key": INTERNAL_KEY,
    },
    body: JSON.stringify({ to, template, data }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`send-email failed for ${to}: ${res.status} ${body}`);
  }
}

// ---------------------------------------------------------------------------
// TASK A — Send 24h appointment reminders
// ---------------------------------------------------------------------------

async function sendReminders(): Promise<{ sent: number; errors: number }> {
  const now = new Date();
  const from23h = new Date(now.getTime() + 23 * 60 * 60 * 1000).toISOString();
  const to25h = new Date(now.getTime() + 25 * 60 * 60 * 1000).toISOString();

  const { data: appointments, error } = await supabaseAdmin
    .from("appointments")
    .select(`
      id, starts_at, booking_reference, price,
      client:clients!inner(email, first_name, last_name, preferred_locale),
      service:services!inner(name),
      staff:staff_profiles(display_name),
      business:businesses!inner(name, storefronts(address, city))
    `)
    .eq("status", "confirmed")
    .is("reminder_sent_at", null)
    .gte("starts_at", from23h)
    .lte("starts_at", to25h);

  if (error) {
    console.error("Failed to query reminder appointments:", error.message);
    return { sent: 0, errors: 1 };
  }

  let sent = 0;
  let errors = 0;

  for (const appt of appointments ?? []) {
    try {
      const client = appt.client as unknown as {
        email: string | null;
        first_name: string;
        last_name: string;
        preferred_locale: string;
      };
      if (!client?.email) continue;

      const service = appt.service as unknown as { name: string };
      const staff = appt.staff as unknown as { display_name: string } | null;
      const business = appt.business as unknown as {
        name: string;
        storefronts: { address: string | null; city: string | null }[] | null;
      };

      const startsAt = new Date(appt.starts_at);
      const dateStr = startsAt.toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      const timeStr = startsAt.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      });

      const storefront = business.storefronts?.[0];
      const salonAddress = [storefront?.address, storefront?.city]
        .filter(Boolean)
        .join(", ");

      const siteUrl = Deno.env.get("SITE_URL") ?? "https://kazionebooking.com";
      const cancelToken = await issueCancelToken(appt.id, appt.booking_reference);
      const manageUrl = `${siteUrl}/booking/${appt.booking_reference}?token=${encodeURIComponent(cancelToken)}`;

      await sendEmailInternal(client.email, "booking_reminder", {
        clientName: `${client.first_name} ${client.last_name}`,
        salonName: business.name,
        serviceName: service.name,
        staffName: staff?.display_name ?? "Any available",
        date: dateStr,
        time: timeStr,
        reference: appt.booking_reference,
        price: `€${Number(appt.price).toFixed(2)}`,
        manageUrl,
        salonAddress,
      });

      // Mark reminder as sent
      await supabaseAdmin
        .from("appointments")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", appt.id);

      sent++;
    } catch (err) {
      console.error(`Reminder error for appointment ${appt.id}:`, err);
      errors++;
    }
  }

  return { sent, errors };
}

// ---------------------------------------------------------------------------
// TASK B — Mark no-shows (confirmed appointments 30+ min past start)
// ---------------------------------------------------------------------------

async function markNoShows(): Promise<{ marked: number; errors: number }> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const { data: appointments, error } = await supabaseAdmin
    .from("appointments")
    .select(`
      id, business_id,
      business:businesses!inner(
        owner_members:business_members!inner(user_id)
      )
    `)
    .eq("status", "confirmed")
    .lt("starts_at", cutoff)
    .eq("business:businesses.owner_members.role", "owner")
    .eq("business:businesses.owner_members.is_active", true);

  if (error) {
    console.error("Failed to query no-show appointments:", error.message);
    return { marked: 0, errors: 1 };
  }

  let marked = 0;
  let errors = 0;

  for (const appt of appointments ?? []) {
    try {
      // Update status to no_show
      const { error: updateErr } = await supabaseAdmin
        .from("appointments")
        .update({
          status: "no_show",
          no_show_marked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", appt.id);

      if (updateErr) throw updateErr;

      // Insert status log
      const { error: logErr } = await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: appt.id,
        old_status: "confirmed",
        new_status: "no_show",
        reason: "Automatically marked as no-show (30 min past start time)",
      });
      if (logErr) throw logErr;

      // Notify business owner
      const business = appt.business as unknown as {
        owner_members: { user_id: string }[];
      };
      const ownerUserId = business.owner_members?.[0]?.user_id;

      if (ownerUserId) {
        const { error: notifErr } = await supabaseAdmin.from("notifications").insert({
          business_id: appt.business_id,
          user_id: ownerUserId,
          type: "no_show",
          title: "No-Show Detected",
          body: `Appointment ${appt.id} was marked as no-show (30+ minutes past start time).`,
          metadata: { appointment_id: appt.id },
        });
        if (notifErr) throw notifErr;
      }

      marked++;
    } catch (err) {
      console.error(`No-show error for appointment ${appt.id}:`, err);
      errors++;
    }
  }

  return { marked, errors };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("send-reminders", async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  if (!verifyCronAuth(req)) {
    return unauthorized("Invalid or missing CRON_SECRET");
  }

  try {
    // Run both tasks in parallel
    const [reminders, noShows] = await Promise.all([
      sendReminders(),
      markNoShows(),
    ]);

    const result = {
      ok: true,
      timestamp: new Date().toISOString(),
      reminders,
      no_shows: noShows,
    };

    console.log("send-reminders completed:", JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-reminders fatal error:", err);
    return serverError(
      err instanceof Error ? err.message : "Internal server error",
    );
  }
}));
