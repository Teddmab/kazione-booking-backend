import { supabaseAdmin } from "./supabaseAdmin.ts";

export interface NotificationRecipient {
  userId: string;
  email: string;
}

/**
 * Who should receive booking-related notifications (new booking, upcoming
 * reminder) for a business — every active staff member marked as
 * `is_supervisor`, or the business owner if none are set.
 *
 * Replaces the old single fixed business_settings.booking_notification_email
 * address (and the dead notify_new_booking toggle, which was never actually
 * read anywhere). Multiple supervisors are supported — each gets notified
 * independently.
 */
export async function getBookingNotificationRecipients(
  businessId: string,
): Promise<NotificationRecipient[]> {
  const { data: supervisors } = await supabaseAdmin
    .from("staff_profiles")
    .select("business_member:business_members(user_id, users(email))")
    .eq("business_id", businessId)
    .eq("is_supervisor", true)
    .eq("is_active", true);

  const recipients: NotificationRecipient[] = [];
  for (const row of supervisors ?? []) {
    const member = (row as Record<string, unknown>).business_member as
      | { user_id: string | null; users: { email: string | null } | null }
      | null;
    const userId = member?.user_id;
    const email = member?.users?.email;
    if (userId && email) recipients.push({ userId, email });
  }
  if (recipients.length > 0) return recipients;

  // Fallback: no supervisor designated yet — notify the business owner,
  // matching the previous always-on behavior for the in-app notification.
  const { data: ownerMember } = await supabaseAdmin
    .from("business_members")
    .select("user_id, users(email)")
    .eq("business_id", businessId)
    .eq("role", "owner")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  const ownerUsers = (ownerMember as Record<string, unknown> | null)?.users as
    | { email: string | null }
    | null;
  const ownerUserId = (ownerMember as Record<string, unknown> | null)?.user_id as string | null | undefined;
  if (ownerUserId && ownerUsers?.email) {
    return [{ userId: ownerUserId, email: ownerUsers.email }];
  }
  return [];
}
