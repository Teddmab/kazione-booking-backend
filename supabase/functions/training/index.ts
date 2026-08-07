import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx, verifyAuth } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

const BUCKET          = "training-videos";
const SIGNED_URL_TTL  = 3600; // seconds

// ─── Client auth helper ───────────────────────────────────────────────────────
// Verifies JWT and confirms the authenticated user's client record owns the redemption.

async function verifyClientAccess(req: Request, redemptionId: string) {
  try {
    const user = await verifyAuth(req);

    const { data: redemption, error: rErr } = await supabaseAdmin
      .from("offer_redemptions")
      .select("id, offer_id, client_id, status, sessions_used, sessions_total, business_id")
      .eq("id", redemptionId)
      .single();

    if (rErr || !redemption) return notFound(req, "Redemption not found");
    if (!redemption.client_id) return forbidden(req, "No client associated with this redemption");

    const { data: client, error: cErr } = await supabaseAdmin
      .from("clients")
      .select("user_id")
      .eq("id", redemption.client_id)
      .single();

    if (cErr || !client || client.user_id !== user.id) {
      return forbidden(req, "You do not have access to this training");
    }

    return { userId: user.id, redemption: redemption as {
      id: string; offer_id: string; client_id: string;
      status: string; sessions_used: number; sessions_total: number | null; business_id: string;
    }};
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("verifyClientAccess error:", e);
    return serverError(req, "Auth check failed");
  }
}

// ─── Signed download URL for a private video ──────────────────────────────────

async function signVideoUrl(path: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabaseAdmin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (error || !data) return null;
  return data.signedUrl;
}

// ─── Rewrite internal Supabase Docker hostname for local dev ──────────────────

function rewriteLocalUrl(u: string): string {
  const internalUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const isLocal = internalUrl.includes("kong") || internalUrl.includes("supabase_");
  if (!isLocal) return u;
  return u.replace(/^https?:\/\/[^/]+(?=\/storage\/)/, "http://127.0.0.1:54321");
}

// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(withLogging("training", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url    = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action") ?? "";
  const id     = url.searchParams.get("id") ?? undefined;

  try {

    // ── GET ?action=course — owner: fetch full course with chapters/sections ──
    if (method === "GET" && action === "course") {
      const offerId    = url.searchParams.get("offer_id");
      const businessId = url.searchParams.get("business_id");
      if (!offerId)    return badRequest(req, "offer_id is required");
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { data: course, error } = await supabaseAdmin
        .from("training_courses")
        .select(`
          id, title, description, offer_id, business_id, created_at, updated_at,
          chapters:training_chapters (
            id, title, position, created_at,
            sections:training_sections ( id, title, content_type, content_text, video_url, position, created_at )
          )
        `)
        .eq("offer_id", offerId)
        .eq("business_id", businessId)
        .maybeSingle();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { course: course ?? null });
    }

    // ── GET ?action=player — client: course + progress for a redemption ───────
    if (method === "GET" && action === "player") {
      const redemptionId = url.searchParams.get("redemption_id");
      if (!redemptionId) return badRequest(req, "redemption_id is required");

      const auth = await verifyClientAccess(req, redemptionId);
      if (auth instanceof Response) return auth;
      const { redemption } = auth;

      const { data: course, error: cErr } = await supabaseAdmin
        .from("training_courses")
        .select(`
          id, title, description,
          chapters:training_chapters (
            id, title, position,
            sections:training_sections ( id, title, content_type, content_text, video_url, position )
          )
        `)
        .eq("offer_id", redemption.offer_id)
        .maybeSingle();

      if (cErr) return serverError(req, cErr.message);
      if (!course) return notFound(req, "No course found for this training");

      // Sign video URLs so the client browser can stream directly
      const chapters = (course as Record<string, unknown>).chapters as Record<string, unknown>[] | null;
      if (chapters) {
        for (const chapter of chapters) {
          const sections = chapter.sections as Record<string, unknown>[] | null;
          if (!sections) continue;
          for (const section of sections) {
            if (section.content_type === "video" && section.video_url) {
              section.video_url = await signVideoUrl(section.video_url as string);
            }
          }
        }
      }

      const { data: progress } = await supabaseAdmin
        .from("training_progress")
        .select("section_id")
        .eq("redemption_id", redemptionId);

      const playerCourse = {
        ...course,
        completed_sections: (progress ?? []).map((p) => p.section_id),
      };

      return jsonCors(req, {
        course: playerCourse,
        redemption: { id: redemption.id, status: redemption.status },
      });
    }

    // ── POST ?action=course — owner: create / upsert course ───────────────────
    if (method === "POST" && action === "course") {
      const body = await req.json().catch(() => null) as {
        business_id: string; offer_id: string; title: string; description?: string;
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, offer_id, title } = body;
      if (!business_id)   return badRequest(req, "business_id is required");
      if (!offer_id)      return badRequest(req, "offer_id is required");
      if (!title?.trim()) return badRequest(req, "title is required");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      const { data: offer } = await supabaseAdmin
        .from("business_offers")
        .select("id, type")
        .eq("id", offer_id)
        .eq("business_id", business_id)
        .single();

      if (!offer) return notFound(req, "Offer not found");
      if (offer.type !== "training") return badRequest(req, "Offer must be type 'training'");

      const { data, error } = await supabaseAdmin
        .from("training_courses")
        .upsert(
          { business_id, offer_id, title: title.trim(), description: body.description?.trim() ?? null },
          { onConflict: "offer_id" },
        )
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { course: data }, 201);
    }

    // ── PATCH ?action=course&id= — owner: update course metadata ─────────────
    if (method === "PATCH" && action === "course" && id) {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return badRequest(req, "Invalid JSON body");
      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const patch: Record<string, unknown> = {};
      if ("title"       in body) patch.title       = (body.title as string)?.trim();
      if ("description" in body) patch.description = body.description ?? null;
      if (Object.keys(patch).length === 0) return badRequest(req, "No updatable fields");

      const { data, error } = await supabaseAdmin
        .from("training_courses")
        .update(patch)
        .eq("id", id)
        .eq("business_id", businessId)
        .select()
        .single();

      if (error) return serverError(req, error.message);
      if (!data)  return notFound(req, "Course not found");
      return jsonCors(req, { course: data });
    }

    // ── POST ?action=chapter — owner: add chapter ─────────────────────────────
    if (method === "POST" && action === "chapter") {
      const body = await req.json().catch(() => null) as {
        business_id: string; course_id: string; title: string; position?: number;
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, course_id, title } = body;
      if (!business_id)   return badRequest(req, "business_id is required");
      if (!course_id)     return badRequest(req, "course_id is required");
      if (!title?.trim()) return badRequest(req, "title is required");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      const { data: course } = await supabaseAdmin
        .from("training_courses")
        .select("id")
        .eq("id", course_id)
        .eq("business_id", business_id)
        .single();

      if (!course) return notFound(req, "Course not found or access denied");

      const { data, error } = await supabaseAdmin
        .from("training_chapters")
        .insert({ course_id, title: title.trim(), position: body.position ?? 0 })
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { chapter: data }, 201);
    }

    // ── PATCH ?action=chapter&id= — owner: update chapter ────────────────────
    if (method === "PATCH" && action === "chapter" && id) {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return badRequest(req, "Invalid JSON body");
      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      // Verify ownership via join
      const { data: ch } = await supabaseAdmin
        .from("training_chapters")
        .select("id, course_id, training_courses!inner(business_id)")
        .eq("id", id)
        .single();

      if (!ch) return notFound(req, "Chapter not found");
      type ChapterJoin = { training_courses: { business_id: string } };
      if ((ch as unknown as ChapterJoin).training_courses.business_id !== businessId)
        return forbidden(req, "Access denied");

      const patch: Record<string, unknown> = {};
      if ("title"    in body) patch.title    = (body.title as string)?.trim();
      if ("position" in body) patch.position = body.position;
      if (Object.keys(patch).length === 0) return badRequest(req, "No updatable fields");

      const { data, error } = await supabaseAdmin
        .from("training_chapters")
        .update(patch)
        .eq("id", id)
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { chapter: data });
    }

    // ── DELETE ?action=chapter — owner: delete chapter (cascades sections) ────
    if (method === "DELETE" && action === "chapter" && id) {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { data: ch } = await supabaseAdmin
        .from("training_chapters")
        .select("id, training_courses!inner(business_id)")
        .eq("id", id)
        .single();

      if (!ch) return notFound(req, "Chapter not found");
      type ChapterJoin = { training_courses: { business_id: string } };
      if ((ch as unknown as ChapterJoin).training_courses.business_id !== businessId)
        return forbidden(req, "Access denied");

      const { error } = await supabaseAdmin.from("training_chapters").delete().eq("id", id);
      if (error) return serverError(req, error.message);
      return jsonCors(req, { success: true });
    }

    // ── POST ?action=section — owner: add section to chapter ─────────────────
    if (method === "POST" && action === "section") {
      const body = await req.json().catch(() => null) as {
        business_id: string; chapter_id: string; title: string;
        content_type: string; content_text?: string; video_url?: string; position?: number;
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, chapter_id, title, content_type } = body;
      if (!business_id)   return badRequest(req, "business_id is required");
      if (!chapter_id)    return badRequest(req, "chapter_id is required");
      if (!title?.trim()) return badRequest(req, "title is required");
      if (!["video", "text", "quiz"].includes(content_type ?? ""))
        return badRequest(req, "content_type must be video, text, or quiz");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      const { data: ch } = await supabaseAdmin
        .from("training_chapters")
        .select("id, training_courses!inner(business_id)")
        .eq("id", chapter_id)
        .single();

      if (!ch) return notFound(req, "Chapter not found");
      type ChapterJoin = { training_courses: { business_id: string } };
      if ((ch as unknown as ChapterJoin).training_courses.business_id !== business_id)
        return forbidden(req, "Access denied");

      const { data, error } = await supabaseAdmin
        .from("training_sections")
        .insert({
          chapter_id,
          title:        title.trim(),
          content_type,
          content_text: body.content_text ?? null,
          video_url:    body.video_url    ?? null,
          position:     body.position     ?? 0,
        })
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { section: data }, 201);
    }

    // ── PATCH ?action=section&id= — owner: update section ────────────────────
    if (method === "PATCH" && action === "section" && id) {
      const body = await req.json().catch(() => null) as Record<string, unknown> | null;
      if (!body) return badRequest(req, "Invalid JSON body");
      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      type SectionJoin = { training_chapters: { training_courses: { business_id: string } } };
      const { data: section } = await supabaseAdmin
        .from("training_sections")
        .select("id, training_chapters!inner(training_courses!inner(business_id))")
        .eq("id", id)
        .single();

      if (!section) return notFound(req, "Section not found");
      if ((section as unknown as SectionJoin).training_chapters.training_courses.business_id !== businessId)
        return forbidden(req, "Access denied");

      const patch: Record<string, unknown> = {};
      if ("title"        in body) patch.title        = (body.title as string)?.trim();
      if ("content_type" in body) patch.content_type = body.content_type;
      if ("content_text" in body) patch.content_text = body.content_text ?? null;
      if ("video_url"    in body) patch.video_url    = body.video_url    ?? null;
      if ("position"     in body) patch.position     = body.position;
      if (Object.keys(patch).length === 0) return badRequest(req, "No updatable fields");

      const { data, error } = await supabaseAdmin
        .from("training_sections")
        .update(patch)
        .eq("id", id)
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { section: data });
    }

    // ── DELETE ?action=section — owner: delete section ────────────────────────
    if (method === "DELETE" && action === "section" && id) {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      type SectionJoin = { training_chapters: { training_courses: { business_id: string } } };
      const { data: section } = await supabaseAdmin
        .from("training_sections")
        .select("id, training_chapters!inner(training_courses!inner(business_id))")
        .eq("id", id)
        .single();

      if (!section) return notFound(req, "Section not found");
      if ((section as unknown as SectionJoin).training_chapters.training_courses.business_id !== businessId)
        return forbidden(req, "Access denied");

      const { error } = await supabaseAdmin.from("training_sections").delete().eq("id", id);
      if (error) return serverError(req, error.message);
      return jsonCors(req, { success: true });
    }

    // ── POST ?action=upload-url — owner: signed video upload URL ─────────────
    if (method === "POST" && action === "upload-url") {
      const body = await req.json().catch(() => null) as {
        business_id: string; course_id: string;
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, course_id } = body;
      if (!business_id) return badRequest(req, "business_id is required");
      if (!course_id)   return badRequest(req, "course_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      const { data: course } = await supabaseAdmin
        .from("training_courses")
        .select("id")
        .eq("id", course_id)
        .eq("business_id", business_id)
        .single();

      if (!course) return notFound(req, "Course not found");

      const videoId     = crypto.randomUUID();
      const storagePath = `${business_id}/${course_id}/${videoId}.mp4`;

      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUploadUrl(storagePath, { upsert: true });

      if (error) return serverError(req, error.message);
      return jsonCors(req, { upload_url: rewriteLocalUrl(data.signedUrl), path: storagePath });
    }

    // ── POST ?action=progress — client: mark section complete ─────────────────
    if (method === "POST" && action === "progress") {
      const body = await req.json().catch(() => null) as {
        redemption_id: string; section_id: string;
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { redemption_id, section_id } = body;
      if (!redemption_id) return badRequest(req, "redemption_id is required");
      if (!section_id)    return badRequest(req, "section_id is required");

      const auth = await verifyClientAccess(req, redemption_id);
      if (auth instanceof Response) return auth;
      const { redemption } = auth;

      if (redemption.status !== "active")
        return badRequest(req, `Training is ${redemption.status}, not active`);

      // Insert; ignore if already marked complete
      const { error: pErr } = await supabaseAdmin
        .from("training_progress")
        .insert({ redemption_id, section_id });

      if (pErr && pErr.code !== "23505") return serverError(req, pErr.message);

      // Check if every section in the course is now complete
      let courseComplete = false;
      const { data: course } = await supabaseAdmin
        .from("training_courses")
        .select("id, training_chapters(training_sections(id))")
        .eq("offer_id", redemption.offer_id)
        .maybeSingle();

      if (course && course.training_chapters) {
        type ChWithSections = { training_sections: { id: string }[] };
        const totalSections = (course.training_chapters as ChWithSections[])
          .reduce((acc, ch) => acc + (ch.training_sections?.length ?? 0), 0);

        if (totalSections > 0) {
          const { count } = await supabaseAdmin
            .from("training_progress")
            .select("id", { count: "exact", head: true })
            .eq("redemption_id", redemption_id);

          if ((count ?? 0) >= totalSections) {
            courseComplete = true;
            const newUsed = (redemption.sessions_used ?? 0) + 1;
            const updates: Record<string, unknown> = { sessions_used: newUsed };
            if (redemption.sessions_total && newUsed >= redemption.sessions_total) {
              updates.status       = "completed";
              updates.completed_at = new Date().toISOString();
            }
            await supabaseAdmin
              .from("offer_redemptions")
              .update(updates)
              .eq("id", redemption_id);
          }
        }
      }

      return jsonCors(req, { success: true, course_complete: courseComplete });
    }

    return badRequest(req, "Unknown route. Expected action: course|player|chapter|section|upload-url|progress");
  } catch (err) {
    console.error("training error:", err);
    return serverError(req, "An unexpected error occurred");
  }
}));
