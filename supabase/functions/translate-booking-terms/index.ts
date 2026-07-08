/**
 * POST /translate-booking-terms
 * Translates the business booking terms to one or all supported locales using Anthropic.
 * Saves translations to business_settings.booking_terms_translations.
 *
 * Body: { business_id: string, locale?: "en" | "et" | "fr" | "ru" }
 *   If locale is omitted, translates to ALL supported locales.
 *
 * Returns: { translations: Record<string, string> }
 */

import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, forbidden, serverError, unauthorized } from "../_shared/errors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const SUPPORTED_LOCALES = ["en", "et", "fr", "ru"];
const LOCALE_NAMES: Record<string, string> = {
  en: "English",
  et: "Estonian",
  fr: "French",
  ru: "Russian",
};

async function translateText(text: string, targetLocale: string, apiKey: string): Promise<string> {
  const targetLang = LOCALE_NAMES[targetLocale] ?? targetLocale;
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `Translate the following booking terms and conditions text to ${targetLang}. Preserve all formatting, line breaks, and structure exactly. Return ONLY the translated text with no explanation or preamble:\n\n${text}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic error: ${err}`);
  }

  const data = await res.json() as { content: Array<{ type: string; text: string }> };
  return data.content?.[0]?.text?.trim() ?? text;
}

Deno.serve(withLogging("translate-booking-terms", async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== "POST") return badRequest("Only POST is allowed");

  let body: { business_id?: string; locale?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("Invalid JSON body");
  }

  const { business_id, locale } = body;
  if (!business_id) return badRequest("Missing business_id");

  // Auth: must be a member of this business
  const user = await requireAuth(req).catch(() => null);
  if (!user) return unauthorized("Authentication required");

  const { data: member } = await supabaseAdmin
    .from("business_members")
    .select("role")
    .eq("business_id", business_id)
    .eq("user_id", user.id)
    .eq("is_active", true)
    .maybeSingle();

  if (!member || !["owner", "manager"].includes(member.role)) {
    return forbidden("Only owners and managers can translate terms");
  }

  // Fetch current terms
  const { data: settings } = await supabaseAdmin
    .from("business_settings")
    .select("booking_terms, booking_terms_translations")
    .eq("business_id", business_id)
    .maybeSingle();

  const termsText = settings?.booking_terms as string | null;
  if (!termsText?.trim()) return badRequest("No booking terms configured to translate");

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return serverError("Translation service not configured");

  // Determine which locales to translate
  const targetLocales = locale
    ? SUPPORTED_LOCALES.includes(locale) ? [locale] : []
    : SUPPORTED_LOCALES;

  if (targetLocales.length === 0) return badRequest(`Unsupported locale: ${locale}`);

  // Translate each locale (in parallel, with a concurrency limit of 2)
  const existing = (settings?.booking_terms_translations ?? {}) as Record<string, string>;
  const results: Record<string, string> = { ...existing };

  const chunks: string[][] = [];
  for (let i = 0; i < targetLocales.length; i += 2) {
    chunks.push(targetLocales.slice(i, i + 2));
  }

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (loc) => {
        try {
          results[loc] = await translateText(termsText, loc, apiKey);
        } catch (e) {
          console.error(`Failed to translate to ${loc}:`, e);
        }
      }),
    );
  }

  // Save translations
  await supabaseAdmin
    .from("business_settings")
    .update({ booking_terms_translations: results })
    .eq("business_id", business_id);

  return new Response(JSON.stringify({ translations: results }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}));
