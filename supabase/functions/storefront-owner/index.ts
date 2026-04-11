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
 * /storefront-owner — owner storefront CRUD (no image uploads — use /storefront-upload)
 *
 * GET  ?business_id=                         → getOwnerStorefront (full record, draft ok)
 * PATCH body={business_id, ...updates}       → upsert storefront fields
 * POST  ?action=publish&business_id=         → publish storefront
 * POST  ?action=unpublish&business_id=       → unpublish storefront
 * DELETE ?action=gallery&id=&image_url=      → delete a gallery image
 * PATCH  ?action=reorder-gallery             → batch-update gallery display_order
 *          body={ business_id, storefront_id, ordered_ids: string[] }
 */
Deno.serve(withLogging("storefront-owner", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { data, error } = await supabaseAdmin
        .from("storefronts")
        .select("*")
        .eq("business_id", ctx.businessId)
        .maybeSingle();

      if (error) return serverError(error.message);
      return json(data);
    }

    // ── PATCH ──────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (action === "reorder-gallery") {
        const body = await req.json() as Record<string, unknown>;
        const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
        if (ctx instanceof Response) return ctx;

        const storefrontId = body.storefront_id as string;
        const orderedIds = body.ordered_ids as string[];

        for (let i = 0; i < orderedIds.length; i++) {
          const { error } = await supabaseAdmin
            .from("storefront_gallery")
            .update({ display_order: i })
            .eq("id", orderedIds[i])
            .eq("storefront_id", storefrontId);

          if (error) return serverError(error.message);
        }

        return json({ ok: true });
      }

      // Upsert storefront fields
      const body = await req.json() as Record<string, unknown>;
      const businessId = body.business_id as string;
      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { business_id: _, ...updates } = body;
      const { data, error } = await supabaseAdmin
        .from("storefronts")
        .upsert(
          { business_id: ctx.businessId, ...updates, updated_at: new Date().toISOString() },
          { onConflict: "business_id" },
        )
        .select("*")
        .single();

      if (error) return serverError(error.message);
      return json(data);
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (method === "POST") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      if (action === "publish") {
        const { error } = await supabaseAdmin
          .from("storefronts")
          .update({ is_published: true, marketplace_status: "active", updated_at: new Date().toISOString() })
          .eq("business_id", ctx.businessId);

        if (error) return serverError(error.message);
        return json({ ok: true });
      }

      if (action === "unpublish") {
        const { error } = await supabaseAdmin
          .from("storefronts")
          .update({ is_published: false, marketplace_status: "draft", updated_at: new Date().toISOString() })
          .eq("business_id", ctx.businessId);

        if (error) return serverError(error.message);
        return json({ ok: true });
      }

      // Insert gallery image record (after client uploaded via presigned URL)
      if (action === "gallery-record") {
        const body = await req.json() as Record<string, unknown>;
        const { data, error } = await supabaseAdmin
          .from("storefront_gallery")
          .insert({
            storefront_id: body.storefront_id,
            image_url: body.image_url,
            display_order: 0,
          })
          .select("*")
          .single();

        if (error) return serverError(error.message);
        return json(data, 201);
      }

      return badRequest(`Unknown action: ${action}`);
    }

    // ── DELETE ─────────────────────────────────────────────────────────────
    if (method === "DELETE" && action === "gallery") {
      const galleryId = url.searchParams.get("id");
      const imageUrl = url.searchParams.get("image_url");
      if (!galleryId) return badRequest("id is required");

      // Fetch gallery row to get storefront's business_id for auth
      const { data: galleryRow } = await supabaseAdmin
        .from("storefront_gallery")
        .select("storefront_id")
        .eq("id", galleryId)
        .maybeSingle();

      if (galleryRow) {
        const { data: sfRow } = await supabaseAdmin
          .from("storefronts")
          .select("business_id")
          .eq("id", (galleryRow as Record<string, unknown>).storefront_id as string)
          .maybeSingle();

        if (sfRow) {
          const ctx = await requireOwnerOrManagerCtx(req, (sfRow as Record<string, unknown>).business_id as string);
          if (ctx instanceof Response) return ctx;
        }
      }

      // Remove from Storage if URL provided
      if (imageUrl) {
        const marker = "/business-assets/";
        const idx = imageUrl.indexOf(marker);
        if (idx !== -1) {
          const storagePath = imageUrl.slice(idx + marker.length);
          await supabaseAdmin.storage.from("business-assets").remove([storagePath]);
        }
      }

      const { error } = await supabaseAdmin
        .from("storefront_gallery")
        .delete()
        .eq("id", galleryId);

      if (error) return serverError(error.message);
      return json({ ok: true });
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("storefront-owner error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
