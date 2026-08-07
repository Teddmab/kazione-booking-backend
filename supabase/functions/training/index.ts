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

    // ── POST ?action=upload-url — owner: signed media upload URL ────────────
    if (method === "POST" && action === "upload-url") {
      const body = await req.json().catch(() => null) as {
        business_id: string; course_id: string; file_name?: string; content_type?: string;
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

      // Derive extension from file_name; default to mp4 for video uploads.
      const fileName = body.file_name ?? "";
      const dotIdx = fileName.lastIndexOf(".");
      const ext = dotIdx >= 0 ? fileName.slice(dotIdx + 1).toLowerCase() : "mp4";

      const assetId     = crypto.randomUUID();
      const storagePath = `${business_id}/${course_id}/${assetId}.${ext}`;

      const { data, error } = await supabaseAdmin.storage
        .from(BUCKET)
        .createSignedUploadUrl(storagePath, { upsert: true });

      if (error) return serverError(req, error.message);
      return jsonCors(req, { upload_url: rewriteLocalUrl(data.signedUrl), path: storagePath });
    }

    // ── GET ?action=my-training — client: list own training redemptions ───────
    if (method === "GET" && action === "my-training") {
      const user = await verifyAuth(req);

      const { data: clientRows } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("user_id", user.id);

      if (!clientRows || clientRows.length === 0) return jsonCors(req, { trainings: [] });
      const clientIds = clientRows.map((c) => c.id);

      // Get all client redemptions
      const { data: redemptions } = await supabaseAdmin
        .from("offer_redemptions")
        .select("id, offer_id, status, sessions_used, sessions_total, created_at")
        .in("client_id", clientIds);

      if (!redemptions || redemptions.length === 0) {
        return jsonCors(req, { trainings: [] });
      }

      const offerIds = redemptions.map((r) => r.offer_id);

      // Get only training-type offers
      const { data: trainingOffers } = await supabaseAdmin
        .from("business_offers")
        .select("id, title, description")
        .in("id", offerIds)
        .eq("type", "training");

      if (!trainingOffers || trainingOffers.length === 0) {
        return jsonCors(req, { trainings: [] });
      }

      const trainingOfferIds = new Set(trainingOffers.map((o) => o.id));

      // Get courses linked to those offers
      const { data: courses } = await supabaseAdmin
        .from("training_courses")
        .select("id, offer_id, title, description")
        .in("offer_id", [...trainingOfferIds]);

      const courseByOfferId = new Map((courses ?? []).map((c) => [c.offer_id, c]));
      const offerById       = new Map(trainingOffers.map((o) => [o.id, o]));

      const trainings = redemptions
        .filter((r) => trainingOfferIds.has(r.offer_id))
        .map((r) => ({
          redemption_id:  r.id,
          offer_id:       r.offer_id,
          status:         r.status,
          sessions_used:  r.sessions_used,
          sessions_total: r.sessions_total,
          created_at:     r.created_at,
          offer_title:    offerById.get(r.offer_id)?.title ?? null,
          course:         courseByOfferId.get(r.offer_id) ?? null,
        }));

      return jsonCors(req, { trainings });
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

    // ── GET ?action=slots — list practice session slots for an offer (public) ──
    if (method === "GET" && action === "slots") {
      const offerId = url.searchParams.get("offer_id");
      if (!offerId) return badRequest(req, "offer_id is required");

      const { data, error } = await supabaseAdmin
        .from("training_session_slots")
        .select("id, offer_id, business_id, staff_profile_id, starts_at, ends_at, max_registrants, notes, created_at")
        .eq("offer_id", offerId)
        .gte("starts_at", new Date().toISOString())
        .order("starts_at", { ascending: true });

      if (error) return serverError(req, error.message);

      // Count bookings per slot so client can see remaining capacity
      const slotIds = (data ?? []).map((s) => s.id);
      const { data: bookingCounts } = slotIds.length > 0
        ? await supabaseAdmin
            .from("training_slot_bookings")
            .select("slot_id")
            .in("slot_id", slotIds)
            .eq("status", "confirmed")
        : { data: [] };

      const countBySlot = new Map<string, number>();
      for (const b of bookingCounts ?? []) {
        countBySlot.set(b.slot_id, (countBySlot.get(b.slot_id) ?? 0) + 1);
      }

      const slots = (data ?? []).map((s) => ({
        ...s,
        booked_count: countBySlot.get(s.id) ?? 0,
        available: (countBySlot.get(s.id) ?? 0) < s.max_registrants,
      }));

      return jsonCors(req, { slots });
    }

    // ── POST ?action=slots — owner: create a practice session slot ────────────
    if (method === "POST" && action === "slots") {
      const body = await req.json().catch(() => null) as {
        business_id: string; offer_id: string; starts_at: string; ends_at: string;
        staff_profile_id?: string; max_registrants?: number; notes?: string;
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, offer_id, starts_at, ends_at } = body;
      if (!business_id) return badRequest(req, "business_id is required");
      if (!offer_id)    return badRequest(req, "offer_id is required");
      if (!starts_at)   return badRequest(req, "starts_at is required");
      if (!ends_at)     return badRequest(req, "ends_at is required");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      const { data, error } = await supabaseAdmin
        .from("training_session_slots")
        .insert({
          offer_id,
          business_id,
          starts_at,
          ends_at,
          staff_profile_id: body.staff_profile_id ?? null,
          max_registrants:  body.max_registrants ?? 1,
          notes:            body.notes ?? null,
        })
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { slot: data }, 201);
    }

    // ── DELETE ?action=slots&id= — owner: delete a slot ──────────────────────
    if (method === "DELETE" && action === "slots" && id) {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest(req, "business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { error } = await supabaseAdmin
        .from("training_session_slots")
        .delete()
        .eq("id", id)
        .eq("business_id", businessId);

      if (error) return serverError(req, error.message);
      return jsonCors(req, { success: true });
    }

    // ── POST ?action=register — client: self-register for a training offer ────
    // Creates an offer_redemption and optionally books practice session slots.
    if (method === "POST" && action === "register") {
      const body = await req.json().catch(() => null) as {
        offer_id: string; slot_ids?: string[];
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { offer_id, slot_ids = [] } = body;
      if (!offer_id) return badRequest(req, "offer_id is required");

      const user = await verifyAuth(req);

      // Resolve offer first (need business_id for client lookup)
      const { data: offer } = await supabaseAdmin
        .from("business_offers")
        .select("id, type, business_id, sessions_total, price")
        .eq("id", offer_id)
        .eq("is_active", true)
        .single();

      if (!offer) return notFound(req, "Training offer not found or not active");
      if (offer.type !== "training") return badRequest(req, "Offer is not a training");

      // Resolve client record — auto-create for marketplace users
      let { data: clientRow } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("user_id", user.id)
        .eq("business_id", offer.business_id)
        .maybeSingle();

      if (!clientRow) {
        // Try to link an existing guest client by email
        const userEmail = user.email ?? null;
        if (userEmail) {
          const { data: byEmail } = await supabaseAdmin
            .from("clients")
            .select("id")
            .eq("business_id", offer.business_id)
            .eq("email", userEmail)
            .maybeSingle();
          if (byEmail) {
            await supabaseAdmin.from("clients").update({ user_id: user.id }).eq("id", byEmail.id);
            clientRow = byEmail;
          }
        }
      }

      if (!clientRow) {
        const meta = (user.user_metadata ?? {}) as Record<string, string>;
        const firstName = (meta.first_name ?? meta.given_name ?? "").trim() || (user.email?.split("@")[0] ?? "Client");
        const lastName  = (meta.last_name  ?? meta.family_name ?? "").trim() || "";
        const { data: newClient, error: clientErr } = await supabaseAdmin
          .from("clients")
          .insert({
            business_id: offer.business_id,
            user_id:     user.id,
            first_name:  firstName,
            last_name:   lastName,
            email:       user.email ?? null,
            source:      "marketplace",
          })
          .select("id")
          .single();
        if (clientErr) return serverError(req, `Failed to create client profile: ${clientErr.message}`);
        clientRow = newClient;
      }

      // Check for existing redemption
      const { data: existing } = await supabaseAdmin
        .from("offer_redemptions")
        .select("id")
        .eq("offer_id", offer_id)
        .eq("client_id", clientRow.id)
        .maybeSingle();

      if (existing) return jsonCors(req, { redemption_id: existing.id, already_registered: true });

      // Create redemption (free registration or pending payment)
      const status = (offer.price === null || offer.price === 0) ? "active" : "pending";
      const { data: redemption, error: rErr } = await supabaseAdmin
        .from("offer_redemptions")
        .insert({
          offer_id,
          client_id:      clientRow.id,
          business_id:    offer.business_id,
          status,
          sessions_total: offer.sessions_total,
          sessions_used:  0,
        })
        .select("id")
        .single();

      if (rErr) return serverError(req, rErr.message);

      // Book selected slots
      if (slot_ids.length > 0) {
        const slotBookings = slot_ids.map((slotId) => ({
          slot_id:       slotId,
          redemption_id: redemption.id,
          client_id:     clientRow.id,
          business_id:   offer.business_id,
          status:        "confirmed",
        }));

        const { error: sbErr } = await supabaseAdmin
          .from("training_slot_bookings")
          .insert(slotBookings);

        if (sbErr) return serverError(req, sbErr.message);
      }

      return jsonCors(req, {
        redemption_id:     redemption.id,
        status,
        booked_slot_count: slot_ids.length,
        already_registered: false,
      }, 201);
    }

    // ── POST ?action=review — client: submit a review after course completion ──
    if (method === "POST" && action === "review") {
      const body = await req.json().catch(() => null) as {
        redemption_id: string; rating: number; comment?: string;
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { redemption_id, rating, comment } = body;
      if (!redemption_id) return badRequest(req, "redemption_id is required");
      if (!rating || rating < 1 || rating > 5) return badRequest(req, "rating must be 1–5");

      const auth = await verifyClientAccess(req, redemption_id);
      if (auth instanceof Response) return auth;
      const { redemption } = auth;

      // Find the course
      const { data: course } = await supabaseAdmin
        .from("training_courses")
        .select("id")
        .eq("offer_id", redemption.offer_id)
        .maybeSingle();

      if (!course) return notFound(req, "Course not found");

      const { data, error } = await supabaseAdmin
        .from("training_reviews")
        .upsert({
          course_id:   course.id,
          client_id:   redemption.client_id,
          business_id: redemption.business_id,
          rating,
          comment: comment?.trim() ?? null,
        }, { onConflict: "course_id,client_id" })
        .select()
        .single();

      if (error) return serverError(req, error.message);
      return jsonCors(req, { review: data }, 201);
    }

    // ── GET ?action=reviews — get reviews for a course (public) ──────────────
    if (method === "GET" && action === "reviews") {
      const courseId = url.searchParams.get("course_id");
      if (!courseId) return badRequest(req, "course_id is required");

      const { data, error } = await supabaseAdmin
        .from("training_reviews")
        .select("id, rating, comment, created_at")
        .eq("course_id", courseId)
        .order("created_at", { ascending: false });

      if (error) return serverError(req, error.message);

      const reviews = data ?? [];
      const avg = reviews.length > 0
        ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
        : null;

      return jsonCors(req, { reviews, average_rating: avg, count: reviews.length });
    }

    // ── GET ?action=my-slots — client: list my booked practice session slots ──
    if (method === "GET" && action === "my-slots") {
      const user = await verifyAuth(req);

      const { data: clientRow } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!clientRow) return jsonCors(req, { bookings: [] });

      const { data, error } = await supabaseAdmin
        .from("training_slot_bookings")
        .select(`
          id, status, created_at,
          slot:training_session_slots ( id, starts_at, ends_at, notes, offer_id )
        `)
        .eq("client_id", clientRow.id)
        .order("created_at", { ascending: false });

      if (error) return serverError(req, error.message);
      return jsonCors(req, { bookings: data ?? [] });
    }

    // ── POST ?action=ai-generate — owner: AI-generated course structure ──────
    if (method === "POST" && action === "ai-generate") {
      const body = await req.json().catch(() => null) as {
        business_id: string; offer_id: string;
        instructions?: string;
        tone?: "beginner" | "intermediate" | "professional";
        language?: string;
      } | null;
      if (!body) return badRequest(req, "Invalid JSON body");

      const { business_id, offer_id } = body;
      if (!business_id) return badRequest(req, "business_id is required");
      if (!offer_id)    return badRequest(req, "offer_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, business_id);
      if (ctx instanceof Response) return ctx;

      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) return serverError(req, "AI generation is not configured on this server");

      const [{ data: offer }, { data: services }, { data: business }] = await Promise.all([
        supabaseAdmin
          .from("business_offers")
          .select("id, title, description, type, sessions_total")
          .eq("id", offer_id)
          .eq("business_id", business_id)
          .single(),
        supabaseAdmin
          .from("services")
          .select("name, description, duration_minutes, price")
          .eq("business_id", business_id)
          .eq("is_active", true)
          .order("name"),
        supabaseAdmin
          .from("businesses")
          .select("name, city, country")
          .eq("id", business_id)
          .single(),
      ]);

      if (!offer) return notFound(req, "Offer not found");
      if (offer.type !== "training") return badRequest(req, "Offer must be type 'training'");

      const tone = body.tone ?? "intermediate";
      const language = body.language ?? "en";
      const serviceList = (services ?? [])
        .map((s: { name: string; description?: string | null; duration_minutes?: number | null; price?: number | null }) =>
          `- ${s.name}${s.duration_minutes ? ` (${s.duration_minutes} min)` : ""}${s.price ? `, €${s.price}` : ""}${s.description ? ` — ${s.description}` : ""}`
        )
        .join("\n");

      const toneMap: Record<string, string> = {
        beginner: "Assume learners are completely new. Avoid jargon. Use simple language, analogies, and step-by-step breakdowns.",
        intermediate: "Assume learners have some experience but are developing their professional skills. Balance theory with hands-on tips.",
        professional: "Write peer-to-peer, like a senior practitioner sharing advanced technique knowledge. Dense, specific, no hand-holding.",
      };

      const systemPrompt =
        "You are a professional beauty education content writer for KaziOne. " +
        "You create training courses that sound natural and written by an experienced practitioner — not AI-generated. " +
        "Your writing draws on real salon workflows, specific service knowledge, and hands-on expertise. " +
        "Always respond with valid JSON only — no text, no markdown, no code fences outside the JSON.";

      const userPrompt = [
        `Business: ${business?.name ?? "the salon"} (${business?.city ?? ""}, ${business?.country ?? ""})`,
        `Training offer: "${offer.title}"`,
        offer.description ? `Offer description: ${offer.description}` : "",
        offer.sessions_total ? `Total sessions: ${offer.sessions_total}` : "",
        serviceList ? `\nServices offered at this business:\n${serviceList}` : "",
        body.instructions ? `\nOwner instructions: ${body.instructions}` : "",
        `\nTone: ${toneMap[tone]}`,
        `Language: ${language === "fr" ? "French" : language === "et" ? "Estonian" : "English"}`,
        "\nCreate a complete training course with 2–4 chapters, each with 2–4 sections.",
        'Sections should alternate between text explanations and practical notes. Set content_type to "video" for 1–2 sections per chapter where filming a demonstration would be ideal.',
        "Keep each content_text between 150–400 words. Use real examples from the business's services.",
        "",
        'Respond with exactly this JSON shape:',
        '{ "course": { "title": "string", "description": "string", "chapters": [{ "title": "string", "sections": [{ "title": "string", "content_type": "text"|"video", "content_text": "string" }] }] } }',
      ].filter(Boolean).join("\n");

      const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 4000,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        console.error("[training/ai-generate] Anthropic error", anthropicRes.status, errText.slice(0, 300));
        return serverError(req, `AI generation failed (${anthropicRes.status})`);
      }

      const aiData = await anthropicRes.json();
      const rawText: string = aiData.content?.[0]?.text ?? "";
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return serverError(req, "AI returned unexpected format — try again");

      let parsed: { course?: unknown };
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return serverError(req, "AI returned invalid JSON — try again");
      }

      return jsonCors(req, { course: parsed.course ?? null });
    }

    return badRequest(req, "Unknown route. Expected action: course|player|chapter|section|upload-url|progress|slots|register|review|reviews|my-slots|ai-generate");
  } catch (err) {
    console.error("training error:", err);
    return serverError(req, "An unexpected error occurred");
  }
}));
