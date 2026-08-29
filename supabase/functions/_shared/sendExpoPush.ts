import { supabaseAdmin } from "./supabaseAdmin.ts";
import { isExpoPushToken } from "./expoPushToken.ts";

export { isExpoPushToken } from "./expoPushToken.ts";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export interface ExpoPushPayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

interface ExpoTicket {
  status?: string;
  id?: string;
  message?: string;
  details?: { error?: string };
}

/**
 * Sends a remote push to every registered device for `userId`.
 * Fire-and-forget safe: never throws to the caller; logs + prunes bad tokens.
 */
export async function sendExpoPushToUser(
  opts: ExpoPushPayload,
): Promise<void> {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from("device_push_tokens")
      .select("id, expo_push_token")
      .eq("user_id", opts.userId);

    if (error) {
      console.warn("[expo-push] token lookup failed:", error.message);
      return;
    }
    if (!rows?.length) return;

    const messages = rows
      .filter((r) => isExpoPushToken(r.expo_push_token as string))
      .map((r) => ({
        to: r.expo_push_token as string,
        title: opts.title,
        body: opts.body,
        sound: "default" as const,
        data: opts.data ?? {},
      }));

    if (messages.length === 0) return;

    // Expo accepts up to 100 messages per request
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(chunk),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(
          `[expo-push] HTTP ${res.status}: ${text.slice(0, 500)}`,
        );
        continue;
      }

      const json = (await res.json().catch(() => null)) as
        | { data?: ExpoTicket[] }
        | ExpoTicket[]
        | null;
      const tickets: ExpoTicket[] = Array.isArray(json)
        ? json
        : Array.isArray(json?.data)
        ? json.data
        : [];

      for (let t = 0; t < tickets.length; t++) {
        const ticket = tickets[t];
        const token = chunk[t]?.to;
        if (!ticket || !token) continue;
        if (ticket.status === "error") {
          const errCode = ticket.details?.error ?? ticket.message ?? "unknown";
          console.warn(`[expo-push] ticket error for ${token}: ${errCode}`);
          if (
            errCode === "DeviceNotRegistered" ||
            String(errCode).includes("DeviceNotRegistered")
          ) {
            await supabaseAdmin
              .from("device_push_tokens")
              .delete()
              .eq("expo_push_token", token);
          }
        }
      }
    }
  } catch (err) {
    console.warn("[expo-push] unexpected error:", err);
  }
}

/** Non-blocking wrapper for use after in-app notification inserts. */
export function notifyUserPush(opts: ExpoPushPayload): void {
  void sendExpoPushToUser(opts);
}
