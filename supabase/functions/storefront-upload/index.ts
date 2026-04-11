import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * POST /storefront-upload
 *
 * Generates a Supabase Storage signed upload URL so the frontend can PUT
 * image files directly without exposing credentials.
 *
 * Body: { business_id, asset_type: "logo" | "cover" | "gallery" }
 * Returns: { upload_url, public_url, path }
 *
 * Frontend workflow:
 *   1. Call this endpoint to get a signed upload URL
 *   2. PUT the image blob directly to upload_url (plain HTTP, no Supabase client)
 *   3. Call PATCH /storefront-owner with { business_id, logo_url | cover_image_url | ... }
 *      to persist the public_url in the DB
 */
Deno.serve(withLogging("storefront-upload", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is allowed" } }, 405);
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const businessId = body.business_id as string;
    const assetType = body.asset_type as string;

    if (!assetType || !["logo", "cover", "gallery"].includes(assetType)) {
      return badRequest("asset_type must be logo, cover, or gallery");
    }

    const ctx = await requireOwnerOrManagerCtx(req, businessId);
    if (ctx instanceof Response) return ctx;

    let storagePath: string;
    if (assetType === "logo") {
      storagePath = `${ctx.businessId}/logo.webp`;
    } else if (assetType === "cover") {
      storagePath = `${ctx.businessId}/cover.webp`;
    } else {
      const imageId = crypto.randomUUID();
      storagePath = `${ctx.businessId}/gallery/${imageId}.webp`;
    }

    const { data, error } = await supabaseAdmin.storage
      .from("business-assets")
      .createSignedUploadUrl(storagePath);

    if (error) return serverError(error.message);

    const { data: urlData } = supabaseAdmin.storage
      .from("business-assets")
      .getPublicUrl(storagePath);

    return json({
      upload_url: data.signedUrl,
      public_url: urlData.publicUrl,
      path: storagePath,
    });
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("storefront-upload error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
