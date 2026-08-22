import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors } from "../_shared/cors.ts";
import { badRequest, unauthorized, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";
import { issueCancelToken } from "../_shared/bookingCancelToken.ts";
import { sendSms } from "../_shared/messagebird.ts";
import { sendClientWaReminder, sendStaffWaReminder } from "../_shared/bird-whatsapp.ts";

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
      staff:staff_profiles(display_name, invited_email, business_member_id),
      business:businesses!inner(name, timezone, storefronts(address, city))
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

  // Fetch settings for all relevant businesses — used for timing window (cron)
  // and owner notification email (all paths).
  const needsWindowFilter = !businessId && !appointmentId;
  const allBusinessIds = [...new Set(appointments.map((a: { business_id: unknown }) => a.business_id as string))];

  interface BizSettings { reminderHours: number; ownerEmail: string | null }
  let settingsMap = new Map<string, BizSettings>();

  {
    const { data: settingsRows, error: settingsErr } = await supabaseAdmin
      .from("business_settings")
      .select("business_id, reminder_hours_before, booking_notification_email")
      .in("business_id", allBusinessIds);

    if (settingsErr) {
      console.error("Failed to query business_settings:", settingsErr.message);
      return { sent: 0, errors: 1 };
    }

    settingsMap = new Map<string, BizSettings>(
      (settingsRows ?? []).map((s: {
        business_id: unknown;
        reminder_hours_before: unknown;
        booking_notification_email: unknown;
      }) => [
        s.business_id as string,
        {
          reminderHours: (s.reminder_hours_before as number) ?? 24,
          ownerEmail: (s.booking_notification_email as string | null) ?? null,
        },
      ]),
    );
  }

  // Apply timing window only for the cron path
  const filteredAppointments = needsWindowFilter
    ? (appointments ?? []).filter((appt) => {
        const hours = settingsMap.get(appt.business_id as string)?.reminderHours ?? 24;
        const windowStart = new Date(now.getTime() + (hours - 1) * 60 * 60 * 1000);
        const windowEnd = new Date(now.getTime() + (hours + 1) * 60 * 60 * 1000);
        return new Date(appt.starts_at) >= windowStart && new Date(appt.starts_at) <= windowEnd;
      })
    : (appointments ?? []);

  // Fetch staff phones via business_members → users for SMS/WA reminders
  const staffMemberIds = [...new Set(
    filteredAppointments
      .map((a) => (a.staff as unknown as { business_member_id: string | null } | null)?.business_member_id)
      .filter(Boolean),
  )] as string[];

  const staffPhoneMap = new Map<string, string>(); // business_member_id → phone
  const staffEmailMap = new Map<string, string>(); // business_member_id → email (authoritative user email)
  if (staffMemberIds.length > 0) {
    const { data: memberRows } = await supabaseAdmin
      .from("business_members")
      .select("id, users(phone, email)")
      .in("id", staffMemberIds);
    for (const m of memberRows ?? []) {
      const user = (m as unknown as { id: string; users: { phone: string | null; email: string | null } | null }).users;
      if (user?.phone) staffPhoneMap.set((m as unknown as { id: string }).id, user.phone);
      if (user?.email) staffEmailMap.set((m as unknown as { id: string }).id, user.email);
    }
  }

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
      const staff = appt.staff as unknown as {
        display_name: string;
        invited_email: string | null;
        business_member_id: string | null;
      } | null;
      const business = appt.business as unknown as {
        name: string;
        timezone: string | null;
        storefronts: { address: string | null; city: string | null }[] | null;
      };
      const businessTimezone = business.timezone ?? "UTC";

      const startsAt = new Date(appt.starts_at);
      const dateStr = startsAt.toLocaleDateString("en-GB", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: businessTimezone,
      });
      const timeStr = startsAt.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: businessTimezone,
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

      // Staff email reminder — prefer the user's registered email over the invite address
      const staffEmail = (staff?.business_member_id
        ? staffEmailMap.get(staff.business_member_id) ?? staff.invited_email
        : staff?.invited_email) ?? null;
      if (staff && staffEmail) {
        await sendEmailInternal(staffEmail, "staff_appointment_reminder", {
          staffName: staff.display_name,
          salonName: business.name,
          clientName: `${client.first_name} ${client.last_name}`,
          serviceName: service.name,
          date: dateStr,
          time: timeStr,
          reference: appt.booking_reference,
        }).catch((err) =>
          console.error(`Staff reminder email failed for appointment ${appt.id}:`, err),
        );
      }

      // Owner email reminder
      const ownerEmail = settingsMap.get(appt.business_id as string)?.ownerEmail;
      if (ownerEmail) {
        await sendEmailInternal(ownerEmail, "owner_appointment_reminder", {
          salonName: business.name,
          clientName: `${client.first_name} ${client.last_name}`,
          clientEmail: client.email ?? "",
          clientPhone: client.phone ?? "",
          serviceName: service.name,
          staffName: staff?.display_name ?? "Any available",
          date: dateStr,
          time: timeStr,
          reference: appt.booking_reference,
          manageUrl: `${siteUrl}/owner/appointments`,
        }).catch((err) =>
          console.error(`Owner reminder email failed for appointment ${appt.id}:`, err),
        );
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
          await sendClientWaReminder(client.phone, {
            clientName: `${client.first_name} ${client.last_name}`,
            serviceName: service.name,
            salonName: business.name,
            date: dateStr,
            time: timeStr,
          }).catch((err) =>
            console.error(`Reminder WhatsApp failed for appointment ${appt.id}:`, err),
          );
          updateFields.reminder_whatsapp_sent_at = now;
        }
      }

      // Staff SMS/WA reminder (if phone available via business_member)
      const staffPhone = staff?.business_member_id
        ? staffPhoneMap.get(staff.business_member_id) ?? null
        : null;
      if (staffPhone) {
        const staffSmsText =
          `${business.name}: reminder — ${client.first_name} ${client.last_name} ` +
          `for ${service.name} on ${dateStr} at ${timeStr}. Ref: ${appt.booking_reference}`;
        await sendSms(staffPhone, staffSmsText).catch((err) =>
          console.error(`Staff SMS reminder failed for appointment ${appt.id}:`, err),
        );
        await sendStaffWaReminder(staffPhone, {
          staffName: staff?.display_name ?? "Staff",
          clientName: `${client.first_name} ${client.last_name}`,
          serviceName: service.name,
          date: dateStr,
          time: timeStr,
        }).catch((err) =>
          console.error(`Staff WhatsApp reminder failed for appointment ${appt.id}:`, err),
        );
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
// TASK B — Create "please resolve this appointment" tasks for owner + staff
//
// Fires once per overdue confirmed appointment (tracked via pending_status_task_at).
// Never changes appointment status — that decision belongs to the owner/staff.
// ---------------------------------------------------------------------------

async function createPendingStatusTasks(
  businessId?: string,
): Promise<{ created: number; skipped: number; errors: number }> {
  // Confirmed appointments whose slot has fully ended and no task has been sent yet
  let query = supabaseAdmin
    .from("appointments")
    .select(`
      id, business_id, booking_reference, starts_at, ends_at,
      staff_profile_id, staff_profile_id_2,
      client:clients(first_name, last_name),
      service:services(name)
    `)
    .eq("status", "confirmed")
    .lt("ends_at", new Date().toISOString())
    .is("pending_status_task_at", null);

  if (businessId) query = query.eq("business_id", businessId);

  const { data: appointments, error } = await query;
  if (error) {
    console.error("Failed to query overdue appointments:", error.message);
    return { created: 0, skipped: 0, errors: 1 };
  }
  if (!appointments || appointments.length === 0) return { created: 0, skipped: 0, errors: 0 };

  // Batch-fetch owner user_ids
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

  const { data: bizRows } = await supabaseAdmin
    .from("businesses")
    .select("id, timezone")
    .in("id", businessIds);
  const bizTimezoneMap = new Map<string, string>(
    (bizRows ?? []).map((b) => [b.id as string, (b.timezone as string | null) ?? "UTC"]),
  );

  // Batch-fetch staff user_ids via staff_profiles → business_members
  const allStaffIds = [
    ...new Set([
      ...appointments.map((a) => a.staff_profile_id as string | null),
      ...appointments.map((a) => a.staff_profile_id_2 as string | null),
    ].filter(Boolean) as string[]),
  ];
  const staffUserMap = new Map<string, string>(); // staff_profile_id → user_id
  if (allStaffIds.length > 0) {
    const { data: staffProfiles } = await supabaseAdmin
      .from("staff_profiles")
      .select("id, business_member_id")
      .in("id", allStaffIds)
      .not("business_member_id", "is", null);
    const memberIds = (staffProfiles ?? [])
      .map((s) => s.business_member_id as string)
      .filter(Boolean);
    if (memberIds.length > 0) {
      const { data: members } = await supabaseAdmin
        .from("business_members")
        .select("id, user_id")
        .in("id", memberIds)
        .eq("is_active", true);
      const memberUserMap = new Map<string, string>(
        (members ?? []).map((m) => [m.id as string, m.user_id as string]),
      );
      for (const sp of staffProfiles ?? []) {
        const userId = memberUserMap.get(sp.business_member_id as string);
        if (userId) staffUserMap.set(sp.id as string, userId);
      }
    }
  }

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const appt of appointments) {
    try {
      const client = appt.client as unknown as Record<string, string> | null;
      const service = appt.service as unknown as Record<string, string> | null;
      const clientName = client ? `${client.first_name} ${client.last_name}`.trim() : "the client";
      const serviceName = service?.name ?? "the appointment";
      const startsAt = new Date(appt.starts_at as string);
      const bizTz = bizTimezoneMap.get(appt.business_id as string) ?? "UTC";
      const dateStr = startsAt.toLocaleDateString("en-GB", {
        weekday: "short", day: "numeric", month: "short", timeZone: bizTz,
      });
      const timeStr = startsAt.toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", timeZone: bizTz,
      });

      const notifTitle = "Action required: appointment outcome";
      const notifBody =
        `${serviceName} with ${clientName} on ${dateStr} at ${timeStr} has ended. ` +
        `Please update its status — mark as completed (and select products used), no-show, or cancelled.`;
      const meta = {
        appointment_id: appt.id,
        action: "resolve_appointment",
        booking_reference: appt.booking_reference,
        client_name: clientName,
        service_name: serviceName,
        starts_at: appt.starts_at,
      };

      const notifications: { business_id: string; user_id: string; type: string; title: string; body: string; metadata: Record<string, unknown> }[] = [];

      const ownerUserId = ownerMap.get(appt.business_id as string);
      if (ownerUserId) {
        notifications.push({
          business_id: appt.business_id as string,
          user_id: ownerUserId,
          type: "action_required",
          title: notifTitle,
          body: notifBody,
          metadata: meta,
        });
      }

      // Primary staff
      if (appt.staff_profile_id) {
        const staffUserId = staffUserMap.get(appt.staff_profile_id as string);
        if (staffUserId && staffUserId !== ownerUserId) {
          notifications.push({
            business_id: appt.business_id as string,
            user_id: staffUserId,
            type: "action_required",
            title: notifTitle,
            body: notifBody,
            metadata: meta,
          });
        }
      }
      // Second staff (dual-stylist)
      if (appt.staff_profile_id_2) {
        const staffUserId2 = staffUserMap.get(appt.staff_profile_id_2 as string);
        if (staffUserId2 && staffUserId2 !== ownerUserId &&
            staffUserId2 !== staffUserMap.get(appt.staff_profile_id as string ?? "")) {
          notifications.push({
            business_id: appt.business_id as string,
            user_id: staffUserId2,
            type: "action_required",
            title: notifTitle,
            body: notifBody,
            metadata: meta,
          });
        }
      }

      if (notifications.length === 0) { skipped++; continue; }

      const { error: notifErr } = await supabaseAdmin
        .from("notifications")
        .insert(notifications);
      if (notifErr) throw notifErr;

      // Mark task as sent — appointment status is NOT changed
      const { error: updateErr } = await supabaseAdmin
        .from("appointments")
        .update({ pending_status_task_at: new Date().toISOString() })
        .eq("id", appt.id as string);
      if (updateErr) throw updateErr;

      created++;
    } catch (err) {
      console.error(`Task creation error for appointment ${appt.id}:`, err);
      errors++;
    }
  }

  return { created, skipped, errors };
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
      const [reminders, tasks] = await Promise.all([
        sendReminders(),
        createPendingStatusTasks(),
      ]);
      const result = { ok: true, timestamp: new Date().toISOString(), reminders, tasks };
      console.log("send-reminders (cron) completed:", JSON.stringify(result));
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
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
    // Skip task creation for single-appointment reminder triggers
    const tasks = body.appointment_id
      ? { created: 0, skipped: 0, errors: 0 }
      : await createPendingStatusTasks(ctx.businessId);
    const result = {
      ok: true,
      timestamp: new Date().toISOString(),
      reminders,
      tasks,
      triggered_by: ctx.userId,
    };
    console.log("send-reminders (manual) completed:", JSON.stringify(result));
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("send-reminders fatal error:", err);
    return serverError(err instanceof Error ? err.message : "Internal server error");
  }
}));
