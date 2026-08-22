import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors, jsonCors } from "../_shared/cors.ts";
import { serverError } from "../_shared/errors.ts";
import { overdueCompletionReminderEmail, sendEmail } from "../_shared/resend.ts";
import { logNotificationDelivery } from "../_shared/notificationLog.ts";

/**
 * send-completion-reminders — finds overdue unfinished appointments and
 * sends the owner an email reminder every 6 hours, up to 5 times.
 *
 * Intended to be called by a cron job (e.g. GitHub Actions scheduled workflow
 * or Supabase pg_cron) every hour; the function itself enforces the 6-hour gap.
 *
 * Can also be triggered manually via POST with no body for testing.
 *
 * Secured via CRON_SECRET environment variable — callers must send
 * Authorization: Bearer <CRON_SECRET>
 */

const CRON_SECRET = Deno.env.get("CRON_SECRET");

function verifyCronAuth(req: Request): boolean {
  if (!CRON_SECRET) return true; // no secret configured — allow (dev only)
  const header = req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const token = header.replace("Bearer ", "");
  // Timing-safe comparison
  const a = new TextEncoder().encode(token);
  const b = new TextEncoder().encode(CRON_SECRET);
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}

Deno.serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // Accept both GET (cron ping) and POST (manual trigger / testing)
  if (req.method !== "GET" && req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeadersFor(req) });
  }

  if (!verifyCronAuth(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
    });
  }

  const now = new Date();
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString();
  const APP_URL = Deno.env.get("APP_URL") ?? "https://kazionebooking.com";

  // Find overdue appointments: ended but not completed/cancelled/no_show,
  // and either never reminded or last reminded ≥6h ago, with <5 reminders sent
  const { data: overdueRows, error: fetchErr } = await supabaseAdmin
    .from("appointments")
    .select(`
      id, business_id, booking_reference, ends_at,
      completion_reminder_count, completion_reminder_last_sent_at,
      client:clients!inner(first_name, last_name),
      service:services!inner(name),
      staff:staff_profiles!staff_profile_id(display_name)
    `)
    .lt("ends_at", now.toISOString())
    .not("status", "in", '("completed","cancelled","no_show")')
    .lt("completion_reminder_count", 5)
    .or(`completion_reminder_last_sent_at.is.null,completion_reminder_last_sent_at.lt.${sixHoursAgo}`);

  if (fetchErr) return serverError(fetchErr.message);

  const rows = (overdueRows ?? []) as Record<string, unknown>[];
  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    const businessId = row.business_id as string;
    const reminderCount = (row.completion_reminder_count as number) + 1;

    // Fetch owner email + business details
    const { data: bizData } = await supabaseAdmin
      .from("businesses")
      .select("name, logo_url, timezone")
      .eq("id", businessId)
      .single();

    const { data: ownerMember } = await supabaseAdmin
      .from("business_members")
      .select("user:users(email)")
      .eq("business_id", businessId)
      .eq("role", "owner")
      .eq("is_active", true)
      .maybeSingle();

    const ownerEmail = ((ownerMember as Record<string, unknown> | null)?.user as Record<string, unknown> | null)?.email as string | null;
    if (!ownerEmail) { skipped++; continue; }

    const biz = bizData as Record<string, unknown> | null;
    const bizTz = (biz?.timezone as string | null) ?? "UTC";
    const client = row.client as Record<string, string> | null;
    const service = row.service as Record<string, string> | null;
    const staff = row.staff as Record<string, string> | null;
    const endsAt = new Date(row.ends_at as string);

    const { subject, html } = overdueCompletionReminderEmail({
      salonName: (biz?.name as string) ?? "KaziOne",
      salonLogoUrl: (biz?.logo_url as string | null) ?? null,
      clientName: client ? `${client.first_name} ${client.last_name}` : "Client",
      serviceName: service?.name ?? "Service",
      staffName: staff?.display_name ?? null,
      date: endsAt.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: bizTz }),
      time: endsAt.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: bizTz }),
      reference: row.booking_reference as string,
      reminderNumber: reminderCount,
      dashboardUrl: `${APP_URL}/owner/appointments`,
    });

    let sendOk = true;
    let messageId: string | null = null;
    let sendError: string | null = null;
    try {
      const result = await sendEmail(ownerEmail, subject, html);
      messageId = result.id;
    } catch (err) {
      sendOk = false;
      sendError = err instanceof Error ? err.message : "Email delivery failed";
    }

    logNotificationDelivery({
      businessId,
      appointmentId: row.id as string,
      channel: "email",
      recipientType: "owner",
      purpose: "completion_reminder",
      status: sendOk ? "sent" : "failed",
      providerMessageId: sendOk ? messageId : null,
      errorMessage: sendOk ? null : sendError,
    });

    if (!sendOk) { skipped++; continue; }

    // Update reminder tracking
    await supabaseAdmin
      .from("appointments")
      .update({
        completion_reminder_count: reminderCount,
        completion_reminder_last_sent_at: now.toISOString(),
      })
      .eq("id", row.id as string);

    sent++;
  }

  return jsonCors(req, { sent, skipped, checked: rows.length });
});
