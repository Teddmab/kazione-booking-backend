import { supabaseAdmin } from "./supabaseAdmin.ts";

export type NotificationChannel = "email" | "sms" | "whatsapp";
export type NotificationRecipientType = "client" | "staff" | "owner";
export type NotificationDeliveryStatus = "sent" | "failed";

export interface NotificationLogEntry {
  businessId: string;
  /** Not every send is appointment-scoped (e.g. staff invites). */
  appointmentId?: string | null;
  channel: NotificationChannel;
  recipientType: NotificationRecipientType;
  /** Short machine-readable purpose, e.g. "booking_reminder", "staff_invite". */
  purpose: string;
  status: NotificationDeliveryStatus;
  providerMessageId?: string | null;
  errorMessage?: string | null;
}

/**
 * Appends a row to notification_delivery_log — the tenant-scoped record of
 * every outbound notification send attempt and its outcome.
 *
 * Fire-and-forget — failures are logged to console but never surface to the
 * caller. A logging failure must never block or delay the actual send.
 */
export async function logNotificationDelivery(entry: NotificationLogEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from("notification_delivery_log").insert({
      business_id: entry.businessId,
      appointment_id: entry.appointmentId ?? null,
      channel: entry.channel,
      recipient_type: entry.recipientType,
      purpose: entry.purpose,
      status: entry.status,
      provider_message_id: entry.providerMessageId ?? null,
      error_message: entry.errorMessage ? entry.errorMessage.slice(0, 2000) : null,
    });

    if (error) {
      console.error("[notificationLog] Insert failed:", error.message);
    }
  } catch (err) {
    console.error("[notificationLog] Unexpected error:", err);
  }
}
