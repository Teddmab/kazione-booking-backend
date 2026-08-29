import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson, adminErrors } from "../_shared/adminCors.ts";
import { requirePlatformAdmin, getCallerIp } from "../_shared/adminAuth.ts";
import { logAdminAction } from "../_shared/adminAudit.ts";
import { withLogging } from "../_shared/logger.ts";

const LOCALES = ["en", "et", "fr", "ru"] as const;
const HERO_SLIDE_KEYS = ["salons", "independent_professionals", "quick_services"] as const;
const BEAUTY_SHOP_STATUSES = ["coming_soon", "live", "disabled"] as const;
const QUICK_SERVICE_STATUSES = ["coming_soon", "pilot", "live", "disabled"] as const;

// Safe, predefined internal destinations only — never an arbitrary URL/JS.
// Keep in sync with the client's CTA-destination map.
const SAFE_CTA_DESTINATIONS = [
  "early_access_salons",
  "discover_professionals",
  "discover",
  "notify_me",
  "how_it_works",
  "quick_service_discover",
  "quick_service_waitlist",
] as const;

type LocalizedText = Partial<Record<(typeof LOCALES)[number], string>>;

interface HeroSlide {
  key: (typeof HERO_SLIDE_KEYS)[number];
  enabled: boolean;
  order: number;
  eyebrow?: LocalizedText;
  title?: LocalizedText;
  description?: LocalizedText;
  statusText?: LocalizedText;
  primaryAction?: string;
  secondaryAction?: string;
  assetKey?: string;
  objectPosition?: string;
}

interface LaunchConfig {
  launchAt?: string | null;
  launchTimezone?: string | null;
  countdownVisible?: boolean;
  earlyAccessEnabled?: boolean;
  beautyShopStatus?: (typeof BEAUTY_SHOP_STATUSES)[number];
  quickServiceStatus?: (typeof QUICK_SERVICE_STATUSES)[number];
  quickServiceRegions?: string[];
  heroSlides?: HeroSlide[];
}

/** IANA timezone validation — Intl throws RangeError on an unknown zone. */
function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates a config is ready to publish. Returns a list of human-readable
 * error messages — empty means valid. Mirrors the client-side
 * validateLaunchConfig() in the admin app so the Publish button can be
 * disabled before the round trip, but this is the authoritative check.
 */
function validateForPublish(config: LaunchConfig): string[] {
  const errors: string[] = [];

  if (config.countdownVisible) {
    if (!config.launchAt) errors.push("launchAt is required when countdownVisible is true");
    else if (Number.isNaN(Date.parse(config.launchAt))) errors.push("launchAt is not a valid ISO 8601 instant");
  }

  if (!config.launchTimezone) {
    errors.push("launchTimezone is required");
  } else if (!isValidTimezone(config.launchTimezone)) {
    errors.push(`launchTimezone "${config.launchTimezone}" is not a recognized IANA timezone`);
  }

  const slides = config.heroSlides ?? [];
  const enabledSlides = slides.filter((s) => s.enabled);
  if (enabledSlides.length === 0) {
    errors.push("At least one hero slide must be enabled");
  }

  const orders = enabledSlides.map((s) => s.order);
  if (new Set(orders).size !== orders.length) {
    errors.push("Hero slide order values must be unique among enabled slides");
  }

  for (const slide of slides) {
    if (!HERO_SLIDE_KEYS.includes(slide.key)) {
      errors.push(`Unknown hero slide key "${slide.key}"`);
    }
    if (slide.primaryAction && !SAFE_CTA_DESTINATIONS.includes(slide.primaryAction as never)) {
      errors.push(`Slide "${slide.key}" primaryAction "${slide.primaryAction}" is not a safe predefined destination`);
    }
    if (slide.secondaryAction && !SAFE_CTA_DESTINATIONS.includes(slide.secondaryAction as never)) {
      errors.push(`Slide "${slide.key}" secondaryAction "${slide.secondaryAction}" is not a safe predefined destination`);
    }
  }

  if (
    (config.quickServiceStatus === "pilot" || config.quickServiceStatus === "live") &&
    (!config.quickServiceRegions || config.quickServiceRegions.length === 0)
  ) {
    errors.push("quickServiceRegions must include at least one region when quickServiceStatus is pilot or live");
  }

  if (config.beautyShopStatus && !BEAUTY_SHOP_STATUSES.includes(config.beautyShopStatus)) {
    errors.push(`Unknown beautyShopStatus "${config.beautyShopStatus}"`);
  }
  if (config.quickServiceStatus && !QUICK_SERVICE_STATUSES.includes(config.quickServiceStatus)) {
    errors.push(`Unknown quickServiceStatus "${config.quickServiceStatus}"`);
  }

  return errors;
}

/**
 * /admin-storefront-launch-config — platform-admin config for the client
 * landing page's launch countdown, hero modes, and capability availability.
 *
 * GET                    → full row: { draft, published, version, publishedAt, publishedBy, updatedAt }
 * PATCH  body=<partial>  → shallow-merges into draft only, never touches published
 * POST   ?action=publish   → validates draft, copies draft -> published, bumps version
 * POST   ?action=unpublish → clears published (site falls back to its safe "not configured" state)
 */
Deno.serve(withLogging("admin-storefront-launch-config", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (req.method === "POST" && action === "publish") {
    const { data: row, error: fetchError } = await supabaseAdmin
      .from("platform_storefront_launch_config")
      .select("draft, version")
      .eq("id", 1)
      .single();

    if (fetchError) {
      console.error("[admin-storefront-launch-config] fetch-before-publish error:", fetchError.message);
      return adminErrors.serverError(fetchError.message);
    }

    const draft = (row?.draft ?? {}) as LaunchConfig;
    const validationErrors = validateForPublish(draft);
    if (validationErrors.length > 0) {
      return adminErrors.badRequest(`Draft is not publish-ready: ${validationErrors.join("; ")}`);
    }

    const nextVersion = (row?.version ?? 0) + 1;
    const { data, error } = await supabaseAdmin
      .from("platform_storefront_launch_config")
      .update({
        published: draft,
        version: nextVersion,
        published_at: new Date().toISOString(),
        published_by: ctx.adminId,
      })
      .eq("id", 1)
      .select("draft, published, version, published_at, published_by, updated_at")
      .single();

    if (error) {
      console.error("[admin-storefront-launch-config] publish error:", error.message);
      return adminErrors.serverError(error.message);
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "STOREFRONT_LAUNCH_CONFIG_PUBLISHED",
      targetMeta: { version: nextVersion },
      ipAddress: getCallerIp(req),
    });

    return adminJson(data);
  }

  if (req.method === "POST" && action === "unpublish") {
    const { data, error } = await supabaseAdmin
      .from("platform_storefront_launch_config")
      .update({ published: null })
      .eq("id", 1)
      .select("draft, published, version, published_at, published_by, updated_at")
      .single();

    if (error) {
      console.error("[admin-storefront-launch-config] unpublish error:", error.message);
      return adminErrors.serverError(error.message);
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "STOREFRONT_LAUNCH_CONFIG_UNPUBLISHED",
      ipAddress: getCallerIp(req),
    });

    return adminJson(data);
  }

  if (req.method === "PATCH") {
    let body: LaunchConfig;
    try {
      body = await req.json();
    } catch {
      return adminErrors.badRequest("Invalid JSON body");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return adminErrors.badRequest("Body must be a JSON object");
    }

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("platform_storefront_launch_config")
      .select("draft")
      .eq("id", 1)
      .single();

    if (fetchError) {
      console.error("[admin-storefront-launch-config] fetch-before-patch error:", fetchError.message);
      return adminErrors.serverError(fetchError.message);
    }

    const mergedDraft = { ...(existing?.draft ?? {}), ...body };

    const { data, error } = await supabaseAdmin
      .from("platform_storefront_launch_config")
      .update({
        draft: mergedDraft,
        updated_at: new Date().toISOString(),
        updated_by: ctx.adminId,
      })
      .eq("id", 1)
      .select("draft, published, version, published_at, published_by, updated_at")
      .single();

    if (error) {
      console.error("[admin-storefront-launch-config] patch error:", error.message);
      return adminErrors.serverError(error.message);
    }

    logAdminAction({
      adminId: ctx.adminId,
      action: "STOREFRONT_LAUNCH_CONFIG_DRAFT_SAVED",
      ipAddress: getCallerIp(req),
    });

    return adminJson(data);
  }

  if (req.method !== "GET") {
    return adminErrors.badRequest("Only GET, PATCH, and POST (?action=publish|unpublish) are allowed");
  }

  // ── GET ────────────────────────────────────────────────────────────────
  const { data, error } = await supabaseAdmin
    .from("platform_storefront_launch_config")
    .select("draft, published, version, published_at, published_by, updated_at")
    .eq("id", 1)
    .maybeSingle();

  if (error) {
    console.error("[admin-storefront-launch-config] fetch error:", error.message);
    return adminErrors.serverError(error.message);
  }

  return adminJson(
    data ?? { draft: {}, published: null, version: 0, published_at: null, published_by: null, updated_at: null },
  );
}));
