/** Expo classic + FCM-style tokens accepted by the Expo push service. */
export function isExpoPushToken(token: string): boolean {
  return (
    /^ExponentPushToken\[.+]$/.test(token) ||
    /^ExpoPushToken\[.+]$/.test(token)
  );
}
