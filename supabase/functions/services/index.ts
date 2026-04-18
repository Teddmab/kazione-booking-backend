import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function parseMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

async function resolveCategoryId(
  businessId: string,
  categoryName?: string | null,
  categoryId?: string | null,
): Promise<string | null> {
  if (categoryId) return categoryId;
  if (!categoryName || !categoryName.trim()) return null;

  const name = categoryName.trim();

  const { data: existing, error: existingErr } = await supabaseAdmin
    .from("service_categories")
    .select("id, business_id")
    .ilike("name", name)
    .or(`business_id.eq.${businessId},business_id.is.null`)
    .order("business_id", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  if (existingErr) throw existingErr;
  if (existing) return existing.id as string;

  const { data: created, error: createErr } = await supabaseAdmin
    .from("service_categories")
    .insert({
      business_id: businessId,
      name,
      display_order: 0,
    })
    .select("id")
    .single();

  if (createErr) throw createErr;
  return (created as { id: string }).id;
}

/**
 * /services — owner/manager service management CRUD
 *
 * GET   ?business_id=               → list services (active + archived)
 * POST  body={business_id, ...}     → create service
 * PATCH ?id= body={...}             → update/archive/restore service
 */
Deno.serve(withLogging("services", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const id = url.searchParams.get("id");

  try {
    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const { data, error } = await supabaseAdmin
        .from("services")
        .select(`
          id,
          business_id,
          category_id,
          name,
          description,
          duration_minutes,
          price,
          currency_code,
          deposit_amount,
          is_active,
          is_public,
          image_url,
          display_order,
          created_at,
          updated_at,
          category:service_categories(name)
        `)
        .eq("business_id", ctx.businessId)
        .order("is_active", { ascending: false })
        .order("display_order", { ascending: true })
        .order("name", { ascending: true });

      if (error) return serverError(error.message);

      const rows = (data ?? []).map((row) => {
        const category = (row as Record<string, unknown>).category as { name?: string } | null;
        return {
          ...(row as Record<string, unknown>),
          category_name: category?.name ?? null,
        };
      });

      return json(rows);
    }

    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;
      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const name = String(body.name ?? "").trim();
      if (!name) return badRequest("name is required");

      const durationMinutes = Number(body.duration_minutes);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        return badRequest("duration_minutes must be a positive number");
      }

      const price = parseMoney(body.price);
      if (price === null || price <= 0) {
        return badRequest("price must be a positive number");
      }

      const depositAmount = parseMoney(body.deposit_amount);
      if (depositAmount !== null && depositAmount < 0) {
        return badRequest("deposit_amount must be >= 0");
      }

      const categoryId = await resolveCategoryId(
        ctx.businessId,
        (body.category_name as string | undefined) ?? null,
        (body.category_id as string | undefined) ?? null,
      );

      const { data, error } = await supabaseAdmin
        .from("services")
        .insert({
          business_id: ctx.businessId,
          category_id: categoryId,
          name,
          description: (body.description as string | undefined)?.trim() || null,
          duration_minutes: durationMinutes,
          price,
          currency_code: (body.currency_code as string | undefined) ?? "EUR",
          deposit_amount: depositAmount,
          is_active: body.is_active !== undefined ? Boolean(body.is_active) : true,
          is_public: body.is_public !== undefined ? Boolean(body.is_public) : true,
          image_url: (body.image_url as string | undefined) ?? null,
          display_order: Number(body.display_order ?? 0),
        })
        .select(`
          id,
          business_id,
          category_id,
          name,
          description,
          duration_minutes,
          price,
          currency_code,
          deposit_amount,
          is_active,
          is_public,
          image_url,
          display_order,
          created_at,
          updated_at,
          category:service_categories(name)
        `)
        .single();

      if (error) return serverError(error.message);

      const category = (data as Record<string, unknown>).category as { name?: string } | null;
      return json({
        ...(data as Record<string, unknown>),
        category_name: category?.name ?? null,
      }, 201);
    }

    if (method === "PATCH") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("services")
        .select("id, business_id")
        .eq("id", id)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Service not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as { business_id: string }).business_id);
      if (ctx instanceof Response) return ctx;

      const updatePayload: Record<string, unknown> = {};

      if (body.name !== undefined) {
        const name = String(body.name ?? "").trim();
        if (!name) return badRequest("name cannot be empty");
        updatePayload.name = name;
      }

      if (body.description !== undefined) {
        updatePayload.description = String(body.description ?? "").trim() || null;
      }

      if (body.duration_minutes !== undefined) {
        const duration = Number(body.duration_minutes);
        if (!Number.isFinite(duration) || duration <= 0) {
          return badRequest("duration_minutes must be a positive number");
        }
        updatePayload.duration_minutes = duration;
      }

      if (body.price !== undefined) {
        const price = parseMoney(body.price);
        if (price === null || price <= 0) return badRequest("price must be a positive number");
        updatePayload.price = price;
      }

      if (body.deposit_amount !== undefined) {
        const depositAmount = parseMoney(body.deposit_amount);
        if (depositAmount !== null && depositAmount < 0) {
          return badRequest("deposit_amount must be >= 0");
        }
        updatePayload.deposit_amount = depositAmount;
      }

      if (body.is_active !== undefined) updatePayload.is_active = Boolean(body.is_active);
      if (body.is_public !== undefined) updatePayload.is_public = Boolean(body.is_public);
      if (body.image_url !== undefined) {
        const imageUrl = String(body.image_url ?? "").trim();
        updatePayload.image_url = imageUrl || null;
      }
      if (body.display_order !== undefined) updatePayload.display_order = Number(body.display_order);

      if (body.category_id !== undefined || body.category_name !== undefined) {
        updatePayload.category_id = await resolveCategoryId(
          ctx.businessId,
          (body.category_name as string | undefined) ?? null,
          (body.category_id as string | undefined) ?? null,
        );
      }

      if (Object.keys(updatePayload).length === 0) {
        return badRequest("No valid fields provided for update");
      }

      const { data, error } = await supabaseAdmin
        .from("services")
        .update(updatePayload)
        .eq("id", id)
        .eq("business_id", ctx.businessId)
        .select(`
          id,
          business_id,
          category_id,
          name,
          description,
          duration_minutes,
          price,
          currency_code,
          deposit_amount,
          is_active,
          is_public,
          image_url,
          display_order,
          created_at,
          updated_at,
          category:service_categories(name)
        `)
        .single();

      if (error) return serverError(error.message);

      const category = (data as Record<string, unknown>).category as { name?: string } | null;
      return json({
        ...(data as Record<string, unknown>),
        category_name: category?.name ?? null,
      });
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("services error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
