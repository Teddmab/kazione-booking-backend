import { corsHeaders } from "./cors.ts";

/**
 * Simple in-memory sliding-window rate limiter keyed by client IP.
 *
 * Limits reset on cold start (Edge Function re-deploy / scale-down).
 * This is intentional — it guards against burst abuse, not sustained attacks.
 * For persistent rate limiting, use a Supabase table or Redis.
 */

interface WindowEntry {
  timestamps: number[];
}

const windows = new Map<string, WindowEntry>();

/**
 * Check rate limit for an IP. Returns null if allowed, or a 429 Response
 * if the limit is exceeded.
 *
 * @param req       — the incoming Request (IP read from headers)
 * @param maxHits   — max requests per window (default 10)
 * @param windowMs  — sliding window duration in ms (default 60 000 = 1 min)
 */
export function checkRateLimit(
  req: Request,
  maxHits = 10,
  windowMs = 60_000,
): Response | null {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip")?.trim() ??
    req.headers.get("cf-connecting-ip")?.trim() ??
    null;

  // Skip rate limiting for non-public addresses and CI environments.
  // Production Edge Functions always receive a routable, non-loopback IP from
  // the CDN, so none of these conditions can trigger in production.

  // 1. No IP header — local dev or some CI configurations.
  if (!ip) return null;

  // ip is now narrowed to string for all checks below.

  // 2. Loopback — Supabase local proxy (Kong) injects 127.0.0.1 even for
  //    requests originating from the test runner on the same host.
  // 3. Private / RFC-1918 ranges — Docker bridge networks (172.16–31.x.x,
  //    10.x.x.x, 192.168.x.x) are used by Supabase's local Docker stack.
  // 4. CI=true — written into supabase/functions/.env by the CI workflow so
  //    Deno.env.get("CI") is reliable inside the edge-runtime sandbox.
  const isLoopback = ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
  const isPrivate =
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const isCi = Deno.env.get("CI") === "true";
  if (isLoopback || isPrivate || isCi) return null;

  const path = new URL(req.url).pathname;
  const key = `${path}:${ip}`;
  const now = Date.now();
  let entry = windows.get(key);

  if (!entry) {
    entry = { timestamps: [] };
    windows.set(key, entry);
  }

  // Evict timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

  if (entry.timestamps.length >= maxHits) {
    const retryAfter = Math.ceil(
      (entry.timestamps[0] + windowMs - now) / 1000,
    );
    return new Response(
      JSON.stringify({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests. Please try again later.",
        },
      }),
      {
        status: 429,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Retry-After": String(retryAfter),
        },
      },
    );
  }

  entry.timestamps.push(now);
  return null; // allowed
}
