import { supabaseAdmin } from "./supabaseAdmin.ts";
import { notifyUserPush } from "./sendExpoPush.ts";

export interface InAppNotificationInput {
  businessId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  /** Extra Expo push data fields (merged with `{ type }`). */
  pushData?: Record<string, string>;
}

/**
 * Inserts an in-app `notifications` row and fires Expo push for the same user.
 * Matches the service-offer / booking pattern: bell + OS banner stay in sync.
 * Never throws — logs and returns false on failure.
 */
export async function insertNotificationAndPush(
  input: InAppNotificationInput,
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.from("notifications").insert({
      business_id: input.businessId,
      user_id: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      metadata: input.metadata ?? {},
    });
    if (error) {
      console.warn(
        `[notify] insert ${input.type} failed:`,
        error.message,
      );
      return false;
    }
    notifyUserPush({
      userId: input.userId,
      title: input.title,
      body: input.body,
      data: { type: input.type, ...(input.pushData ?? {}) },
    });
    return true;
  } catch (err) {
    console.warn(`[notify] unexpected ${input.type}:`, err);
    return false;
  }
}

/** Resolve auth user_id for a staff_profiles row via business_members. */
export async function resolveStaffUserId(
  staffProfileId: string,
): Promise<string | null> {
  const { data: profile } = await supabaseAdmin
    .from("staff_profiles")
    .select("business_member_id")
    .eq("id", staffProfileId)
    .maybeSingle();
  const memberId = (profile as { business_member_id?: string | null } | null)
    ?.business_member_id;
  if (!memberId) return null;
  const { data: member } = await supabaseAdmin
    .from("business_members")
    .select("user_id")
    .eq("id", memberId)
    .maybeSingle();
  return (member as { user_id?: string | null } | null)?.user_id ?? null;
}
