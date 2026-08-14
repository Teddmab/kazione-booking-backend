import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleAdminCors, adminJson } from "../_shared/adminCors.ts";
import { badRequest, serverError, notFound } from "../_shared/errors.ts";
import { requirePlatformAdmin } from "../_shared/adminAuth.ts";
import { withLogging } from "../_shared/logger.ts";

Deno.serve(withLogging("admin-help", async (req: Request) => {
  const cors = handleAdminCors(req);
  if (cors) return cors;

  const ctx = await requirePlatformAdmin(req);
  if (ctx instanceof Response) return ctx;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  // ── GET: list all help items ─────────────────────────────────────────────
  if (req.method === "GET") {
    const { data, error } = await supabaseAdmin
      .from("contextual_help")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[admin-help] list error:", error.message);
      return serverError();
    }
    return adminJson({ data });
  }

  // ── POST: create ─────────────────────────────────────────────────────────
  if (req.method === "POST") {
    let body: {
      title: string;
      description?: string;
      video_url?: string;
      quiz_json?: unknown;
      target_path: string;
      target_section?: string;
      target_element?: string;
      portal?: string;
      is_active?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    if (!body.title?.trim()) return badRequest("title is required");
    if (!body.target_path?.trim()) return badRequest("target_path is required");

    const { data, error } = await supabaseAdmin
      .from("contextual_help")
      .insert({
        title: body.title.trim(),
        description: body.description?.trim() ?? null,
        video_url: body.video_url?.trim() ?? null,
        quiz_json: body.quiz_json ?? null,
        target_path: body.target_path.trim(),
        target_section: body.target_section?.trim() ?? null,
        target_element: body.target_element?.trim() ?? null,
        portal: body.portal ?? "owner",
        is_active: body.is_active ?? true,
      })
      .select()
      .single();

    if (error) {
      console.error("[admin-help] insert error:", error.message);
      return serverError();
    }
    return adminJson(data, 201);
  }

  // ── PATCH: update ────────────────────────────────────────────────────────
  if (req.method === "PATCH") {
    if (!id) return badRequest("id is required");

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return badRequest("Invalid JSON body");
    }

    const allowed = [
      "title", "description", "video_url", "quiz_json",
      "target_path", "target_section", "target_element", "portal", "is_active",
    ];
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (key in body) update[key] = body[key];
    }

    const { data, error } = await supabaseAdmin
      .from("contextual_help")
      .update(update)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (error.code === "PGRST116") return notFound("Help item not found");
      console.error("[admin-help] update error:", error.message);
      return serverError();
    }
    return adminJson(data);
  }

  // ── DELETE ───────────────────────────────────────────────────────────────
  if (req.method === "DELETE") {
    if (!id) return badRequest("id is required");

    const { error } = await supabaseAdmin
      .from("contextual_help")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("[admin-help] delete error:", error.message);
      return serverError();
    }
    return adminJson({ deleted: true });
  }

  return badRequest("Method not allowed");
}));
