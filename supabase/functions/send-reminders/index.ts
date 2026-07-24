import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, unauthorized, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";
import { issueCancelToken } from "../_shared/bookingCancelToken.ts";
import { sendSms } from "../_shared/messagebird.ts";
import { sendWhatsApp } from "../_shared/meta-whatsapp.ts";

// ---------------------------------------------------------------------------
// Auth — CRON_SECRET header check
// ---------------------------------------------------------------------------

const CRON_SECRET = Deno.env.get("CRON_SECRET");

function verifyCronAuth(req: Request): boolean {
  if (!CRON_SECRET) {
    console.error("[send-reminders] CRON_SECRET env var is not set");
    return false;
  }
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;

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
const INTERNAL_KEY = Deno.env.get("INTERNAL_FUNCTION_KEY") ?? "";

async function sendEmailInternal(
  to: string,
  template: string,
  data: Record<string, string>,
): Promise<boolean> {
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
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// TASK A — Send appointment reminders
//
// businessId only  → all un-reminded upcoming appointments for that business
//                    (owner "send all now" — timing window skipped)
// businessId + appointmentId → single appointment, ignores reminder_sent_at
//                    so the owner can re-send at will
// neither          → all businesses, timing window respected (cron path)
// ---------------------------------------------------------------------------

async function sendReminders(
  businessId?: string,
  appointmentId?: string,
): Promise<{ sent: number; errors: number }> {
  const now = new Date();
  const maxLookahead = new Date(now.getTime() + 49 * 60 * 60 * 1000).toISOString();

  let query = supabaseAdmin
    .from("appointments")
    .select(`
      id, starts_at, booking_reference, price, business_id,
      reminder_sms_sent_at, reminder_whatsapp_sent_at,
      client:clients!inner(email, phone, first_name, last_name, preferred_locale),
      service:services!inner(name),
      staff:staff_profiles(display_name),
      business:businesses!inner(name, storefronts(address, city))
    `)
    .eq("status", "confirmed");

  if (appointmentId) {
    // Manual per-appointment trigger — no time window, allows re-send regardless of reminder_sent_at
    query = query.eq("id", appointmentId);
  } else {
    // Bulk path: only future un-reminded appointments within the lookahead window
    query = query
      .gte("starts_at", now.toISOString())
      .lte("starts_at", maxLookahead)
      .is("reminder_sent_at", null);
    if (businessId) query = query.eq("business_id", businessId);
  }

  const { data: appointments, error } = await query;

  if (error) {
    console.error("Failed to query reminder appointments:", error.message);
    return { sent: 0, errors: 1 };
  }

  if (!appointments || appointments.length === 0) return { sent: 0, errors: 0 };

  // Fetch reminder_hours_before for each distinct business (cron path only)
  const needsWindowFilter = !businessId && !appointmentId;
  let settingsMap = new Map<string, number>();

  if (needsWindowFilter) {
    const businessIds = [...new Set(appointments.map((a: { business_id: unknown }) => a.business_id as string))];
    const { data: settingsRows, error: settingsErr } = await supabaseAdmin
      .from("business_settings")
      .select("business_id, reminder_hours_before")
      .in("business_id", businessIds);

    if (settingsErr) {
      console.error("Failed to query business_settings:", settingsErr.message);
      return { sent: 0, errors: 1 };
    }

    settingsMap = new Map<string, number>(
      (settingsRows ?? []).map((s: { business_id: unknown; reminder_hours_before: unknown }) => [
        s.business_id as string,
        (s.reminder_hours_before as number) ?? 24,
      ]),
    );
  }

  // Apply timing window only for the cron path
  const filteredAppointments = needsWindowFilter
    ? (appointments ?? []).filter((appt) => {
        const hours = settingsMap.get(appt.business_id as string) ?? 24;
        const windowStart = new Date(now.getTime() + (hours - 1) * 60 * 60 * 1000);
        const windowEnd = new Date(now.getTime() + (hours + 1) * 60 * 60 * 1000);
        return new Date(appt.starts_at) >= windowStart && new Date(appt.starts_at) <= windowEnd;
      })
    : (appointments ?? []);

  let sent = 0;
  let errors = 0;

  for (const appt of filteredAppointments) {
    try {
      const client = appt.client as unknown as {
        email: string | null;
        phone: string | null;
        first_name: string;
        last_name: string;
        preferred_locale: string;
      };
      if (!client?.email && !client?.phone) continue;

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

      const emailDelivered = client.email
        ? await sendEmailInternal(client.email, "booking_reminder", {
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
          })
        : true; // no email address — not a failure

      if (!emailDelivered) {
        errors++;
        continue;
      }

      const now = new Date().toISOString();
      const updateFields: Record<string, string> = { reminder_sent_at: now };

      // SMS reminder
      if (client.phone) {
        const smsText =
          `${business.name}: reminder — ${service.name} on ${dateStr} at ${timeStr}. ` +
          `Ref: ${appt.booking_reference}. Manage: ${manageUrl}`;
        const smsAlreadySent = !!(appt as unknown as { reminder_sms_sent_at: string | null }).reminder_sms_sent_at;
        if (!smsAlreadySent) {
          await sendSms(client.phone, smsText).catch((err) =>
            console.error(`Reminder SMS failed for appointment ${appt.id}:`, err),
          );
          updateFields.reminder_sms_sent_at = now;
        }
        const waAlreadySent = !!(appt as unknown as { reminder_whatsapp_sent_at: string | null }).reminder_whatsapp_sent_at;
        if (!waAlreadySent) {
          await sendWhatsApp(client.phone, smsText).catch((err) =>
            console.error(`Reminder WhatsApp failed for appointment ${appt.id}:`, err),
          );
          updateFields.reminder_whatsapp_sent_at = now;
        }
      }

      await supabaseAdmin
        .from("appointments")
        .update(updateFields)
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
// Optional businessId scopes to a single business (owner manual trigger).
// ---------------------------------------------------------------------------

async function markNoShows(
  businessId?: string,
): Promise<{ marked: number; errors: number }> {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  let query = supabaseAdmin
    .from("appointments")
    .select("id, business_id")
    .eq("status", "confirmed")
    .lt("starts_at", cutoff);

  if (businessId) query = query.eq("business_id", businessId);

  const { data: appointments, error } = await query;

  if (error) {
    console.error("Failed to query no-show appointments:", error.message);
    return { marked: 0, errors: 1 };
  }

  if (!appointments || appointments.length === 0) return { marked: 0, errors: 0 };

  // Fetch owner user_ids for all distinct businesses in one query
  const businessIds = [...new Set(appointments.map((a) => a.business_id as string))];
  const { data: ownerMembers } = await supabaseAdmin
    .from("business_members")
    .select("business_id, user_id")
    .in("business_id", businessIds)
    .eq("role", "owner")
    .eq("is_active", true);

  const ownerMap = new Map<string, string>(
    (ownerMembers ?? []).map((m) => [m.business_id as string, m.user_id as string]),
  );

  let marked = 0;
  let errors = 0;

  for (const appt of appointments) {
    try {
      const { error: updateErr } = await supabaseAdmin
        .from("appointments")
        .update({
          status: "no_show",
          no_show_marked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", appt.id);

      if (updateErr) throw updateErr;

      const { error: logErr } = await supabaseAdmin.from("appointment_status_log").insert({
        appointment_id: appt.id,
        old_status: "confirmed",
        new_status: "no_show",
        reason: "Automatically marked as no-show (30 min past start time)",
      });
      if (logErr) throw logErr;

      const ownerUserId = ownerMap.get(appt.business_id as string);
      if (ownerUserId) {
        await supabaseAdmin.from("notifications").insert({
          business_id: appt.business_id,
          user_id: ownerUserId,
          type: "no_show",
          title: "No-Show Detected",
          body: `Appointment ${appt.id} was marked as no-show (30+ minutes past start time).`,
          metadata: { appointment_id: appt.id },
        });
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

  // ── Path 1: CRON_SECRET — runs across all businesses ──────────────────
  if (verifyCronAuth(req)) {
    try {
      const [reminders, noShows] = await Promise.all([
        sendReminders(),
        markNoShows(),
      ]);
      const result = { ok: true, timestamp: new Date().toISOString(), reminders, no_shows: noShows };
      console.log("send-reminders (cron) completed:", JSON.stringify(result));
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("send-reminders fatal error:", err);
      return serverError(err instanceof Error ? err.message : "Internal server error");
    }
  }

  // ── Path 2: owner JWT — runs scoped to their business ─────────────────
  let body: { business_id?: string; appointment_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }

  if (!body.business_id) {
    return unauthorized("Invalid or missing CRON_SECRET");
  }

  const ctx = await requireOwnerOrManagerCtx(req, body.business_id);
  if (ctx instanceof Response) return ctx;

  try {
    const reminders = await sendReminders(ctx.businessId, body.appointment_id);
    // Skip no-show detection for single-appointment triggers
    const noShows = body.appointment_id
      ? { marked: 0, errors: 0 }
      : await markNoShows(ctx.businessId);
    const result = {
      ok: true,
      timestamp: new Date().toISOString(),
      reminders,
      no_shows: noShows,
      triggered_by: ctx.userId,
    };
    console.log("send-reminders (manual) completed:", JSON.stringify(result));
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-reminders fatal error:", err);
    return serverError(err instanceof Error ? err.message : "Internal server error");
  }
}));
