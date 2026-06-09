import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const BUSINESS_FIELDS = new Set(["name", "business_type", "country"]);

const SETTINGS_FIELDS = new Set([
  "operating_hours",
  "notify_new_booking",
  "notify_cancellation",
  "notify_daily_summary",
  "notify_weekly_report",
  "notify_client_message",
  "admin_locale",
  "storefront_locale",
  "currency_code",
  "date_format",
  "deposit_percent",
  "allow_pay_later",
  "cancellation_hours",
  "reschedule_hours",
  "auto_confirm",
  "max_advance_days",
  "buffer_minutes",
  "enabled_payment_methods",
]);

type DbRow = Record<string, unknown>;

function normalizeSettings(row: DbRow | null): DbRow | null {
  if (!row) return null;
  return {
    id: row.id,
    business_id: row.business_id,
    operating_hours: row.operating_hours ?? null,
    notify_new_booking: row.notify_new_booking ?? true,
    notify_cancellation: row.notify_cancellation ?? true,
    notify_daily_summary: row.notify_daily_summary ?? true,
    notify_weekly_report: row.notify_weekly_report ?? true,
    notify_client_message: row.notify_client_message ?? true,
    admin_locale: row.admin_locale ?? "en",
    storefront_locale: row.storefront_locale ?? "en",
    currency_code: row.currency_code ?? "EUR",
    date_format: row.date_format ?? "dmy",
    deposit_percent: row.deposit_percentage != null
      ? Math.round(Number(row.deposit_percentage))
      : 25,
    allow_pay_later: row.allow_pay_later ?? true,
    cancellation_hours: row.cancellation_hours ?? 24,
    reschedule_hours: row.reschedule_hours ?? 24,
    auto_confirm: row.auto_confirm ?? true,
    max_advance_days: row.booking_future_days ?? 60,
    buffer_minutes: row.buffer_minutes ?? 0,
    enabled_payment_methods: row.enabled_payment_methods ??
      ["deposit", "full", "later"],
  };
}

function mapSettingsPatch(body: DbRow): DbRow {
  const patch: DbRow = {};
  for (const [key, value] of Object.entries(body)) {
    if (!SETTINGS_FIELDS.has(key)) continue;
    if (key === "deposit_percent") {
      patch.deposit_percentage = Number(value);
      continue;
    }
    if (key === "max_advance_days") {
      patch.booking_future_days = Number(value);
      continue;
    }
    patch[key] = value;
  }
  if (Array.isArray(patch.enabled_payment_methods)) {
    const methods = patch.enabled_payment_methods as string[];
    const allowed = ["deposit", "full", "later"];
    if (!methods.every((m) => allowed.includes(m))) {
      throw badRequest("enabled_payment_methods must be a subset of deposit, full, later");
    }
  }
  return patch;
}

/**
 * /business-settings — owner business + settings (replaces direct Supabase from frontends)
 *
 * GET   ?business_id=  → { business, settings }
 * PATCH body={ business_id, ...fields } → { business, settings }
 */
Deno.serve(withLogging("business-settings", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;

  try {
    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const [businessResult, settingsResult] = await Promise.all([
        supabaseAdmin
          .from("businesses")
          .select("id, name, business_type, country, owner_id")
          .eq("id", ctx.businessId)
          .single(),
        supabaseAdmin
          .from("business_settings")
          .select("*")
          .eq("business_id", ctx.businessId)
          .maybeSingle(),
      ]);

      if (businessResult.error) return serverError(businessResult.error.message);
      if (settingsResult.error) return serverError(settingsResult.error.message);

      return json({
        business: businessResult.data,
        settings: normalizeSettings(settingsResult.data as DbRow | null),
      });
    }

    if (method === "PATCH") {
      const body = await req.json() as DbRow;
      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const businessPatch: DbRow = {};
      for (const key of BUSINESS_FIELDS) {
        if (body[key] !== undefined) businessPatch[key] = body[key];
      }

      let settingsPatch: DbRow;
      try {
        settingsPatch = mapSettingsPatch(body);
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }

      if (Object.keys(businessPatch).length > 0) {
        const { error } = await supabaseAdmin
          .from("businesses")
          .update(businessPatch)
          .eq("id", ctx.businessId);
        if (error) return serverError(error.message);
      }

      if (Object.keys(settingsPatch).length > 0) {
        const { data: existing } = await supabaseAdmin
          .from("business_settings")
          .select("id")
          .eq("business_id", ctx.businessId)
          .maybeSingle();

        if (existing) {
          const { error } = await supabaseAdmin
            .from("business_settings")
            .update({ ...settingsPatch, updated_at: new Date().toISOString() })
            .eq("business_id", ctx.businessId);
          if (error) return serverError(error.message);
        } else {
          const { error } = await supabaseAdmin
            .from("business_settings")
            .insert({ business_id: ctx.businessId, ...settingsPatch });
          if (error) return serverError(error.message);
        }
      }

      const [businessResult, settingsResult] = await Promise.all([
        supabaseAdmin
          .from("businesses")
          .select("id, name, business_type, country, owner_id")
          .eq("id", ctx.businessId)
          .single(),
        supabaseAdmin
          .from("business_settings")
          .select("*")
          .eq("business_id", ctx.businessId)
          .maybeSingle(),
      ]);

      if (businessResult.error) return serverError(businessResult.error.message);
      if (settingsResult.error) return serverError(settingsResult.error.message);

      return json({
        business: businessResult.data,
        settings: normalizeSettings(settingsResult.data as DbRow | null),
      });
    }

    return badRequest(`Method ${method} is not supported`);
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[business-settings] Unhandled error:", err);
    return serverError(err instanceof Error ? err.message : "Internal server error");
  }
}));
