import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, conflict, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth } from "../_shared/auth.ts";
import { logServiceActivity } from "../_shared/serviceActivity.ts";

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
 * GET    ?business_id=               → list services (active + archived)
 * GET    ?action=activity&id=        → recent activity feed for one service
 * POST   body={business_id, ...}     → create service
 * POST   ?action=duplicate&id=       → clone a service (no staff assignments)
 * PATCH  ?id= body={...}             → update/archive/restore/publish service
 * DELETE ?id=                        → delete a service (blocked if it has any appointment history)
 */
Deno.serve(withLogging("services", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");
  const id = url.searchParams.get("id");

  try {
    if (method === "GET" && action === "activity") {
      if (!id) return badRequest("id is required");

      const { data: svc } = await supabaseAdmin
        .from("services")
        .select("business_id")
        .eq("id", id)
        .maybeSingle();
      if (!svc) return notFound("Service not found");

      const ctx = await requireOwnerOrManagerCtx(req, (svc as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const [logRes, apptRes] = await Promise.all([
        supabaseAdmin
          .from("service_activity_log")
          .select("id, event_type, payload, created_at")
          .eq("service_id", id)
          .order("created_at", { ascending: false })
          .limit(50),
        // "Relevant booking activity" is derived directly from appointments,
        // not logged — service_activity_log does not duplicate booking events.
        supabaseAdmin
          .from("appointments")
          .select("id, status, starts_at, updated_at")
          .eq("service_id", id)
          .order("updated_at", { ascending: false })
          .limit(10),
      ]);

      return jsonCors(req, {
        events: logRes.data ?? [],
        recent_bookings: apptRes.data ?? [],
      });
    }

    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      // Owner/manager: full list including inactive + auto_show_to_staff.
      // Any active business member (staff): active-only read access via a
      // separate query that does NOT reference auto_show_to_staff, so the
      // staff path works even if migration 067 has not yet been applied.
      const ctx = await requireOwnerOrManagerCtx(req, businessId);

      if (ctx instanceof Response) {
        // Not owner/manager — check if they are an active staff member.
        let user;
        try { user = await verifyAuth(req); } catch { return ctx; }
        const { data: membership } = await supabaseAdmin
          .from("business_members")
          .select("id, role")
          .eq("user_id", user.id)
          .eq("business_id", businessId)
          .eq("is_active", true)
          .maybeSingle();
        if (!membership) return ctx;

        // Resolve the staff profile for this member.
        const memberId = (membership as { id: string; role: string }).id;
        const { data: sp } = await supabaseAdmin
          .from("staff_profiles")
          .select("id")
          .eq("business_member_id", memberId)
          .eq("business_id", businessId)
          .maybeSingle();
        const staffProfileId = (sp as { id: string } | null)?.id ?? null;

        if (!staffProfileId) return jsonCors(req, []);

        // Fetch only services assigned to this staff member (pending + accepted).
        const { data: assignments } = await supabaseAdmin
          .from("staff_services")
          .select("service_id, status, custom_price, offered_commission_type, offered_commission_value")
          .eq("staff_profile_id", staffProfileId)
          .in("status", ["pending", "accepted"]);

        const serviceIds = (assignments ?? []).map(
          (a: Record<string, unknown>) => a.service_id as string,
        );
        if (serviceIds.length === 0) return jsonCors(req, []);

        const { data, error } = await supabaseAdmin
          .from("services")
          .select(`
            id, business_id, category_id, name, description,
            duration_minutes, buffer_minutes, price, currency_code,
            deposit_amount, is_active, is_public, image_url,
            image_url_2, image_url_3, display_order,
            staff_commission_type, staff_commission_value,
            use_intake_form, requires_two_staff, commission_split_pct,
            created_at, updated_at,
            category:service_categories(name)
          `)
          .in("id", serviceIds)
          .eq("business_id", businessId)
          .eq("is_active", true)
          .order("display_order", { ascending: true })
          .order("name", { ascending: true });

        if (error) return serverError(error.message);

        const assignmentMap = new Map(
          (assignments ?? []).map((a: Record<string, unknown>) => [a.service_id as string, a]),
        );

        const staffRows = (data ?? []).map((row) => {
          const r = row as Record<string, unknown>;
          const category = r.category as { name?: string } | null;
          const a = (assignmentMap.get(r.id as string) ?? {}) as Record<string, unknown>;
          return {
            ...r,
            category_name: category?.name ?? null,
            assignment_status: (a.status as string | undefined) ?? "accepted",
            effective_price: a.custom_price != null ? Number(a.custom_price) : r.price,
            offered_commission_type: (a.offered_commission_type as string | undefined) ?? null,
            offered_commission_value: a.offered_commission_value != null
              ? Number(a.offered_commission_value)
              : null,
          };
        });

        // Show pending offers first so staff see what needs their response.
        staffRows.sort((a, b) => {
          const ap = a.assignment_status === "pending" ? 0 : 1;
          const bp = b.assignment_status === "pending" ? 0 : 1;
          return ap - bp;
        });

        return jsonCors(req, staffRows);
      }

      // Owner / manager path — full list with all columns including
      // auto_show_to_staff, plus catalogue-wide staff/product signals so the
      // Services page can render them per row without an N+1 fan-out (one
      // getStaffServices/service-usage call per service). Same embedding
      // pattern already proven in appointments/index.ts's APPT_SELECT.
      const { data, error } = await supabaseAdmin
        .from("services")
        .select(`
          id, business_id, category_id, name, description,
          duration_minutes, buffer_minutes, price, currency_code,
          deposit_amount, is_active, is_public, status, image_url,
          image_url_2, image_url_3, display_order,
          staff_commission_type, staff_commission_value,
          use_intake_form, auto_show_to_staff,
          requires_two_staff, commission_split_pct,
          created_at, updated_at,
          category:service_categories(name),
          staff_services(status, role, effective_date, offered_commission_type, offered_commission_value, assigned_at, responded_at, staff:staff_profiles(id, display_name, avatar_url, position)),
          service_product_usage(product:product_catalog(current_stock, min_stock_alert))
        `)
        .eq("business_id", businessId)
        .order("is_active", { ascending: false })
        .order("display_order", { ascending: true })
        .order("name", { ascending: true });

      if (error) return serverError(error.message);

      const rows = (data ?? []).map((row) => {
        const r = row as Record<string, unknown>;
        const category = r.category as { name?: string } | null;

        const staffLinks = (r.staff_services ?? []) as Array<{
          status: string;
          role: string;
          effective_date: string | null;
          offered_commission_type: string | null;
          offered_commission_value: number | null;
          assigned_at: string | null;
          responded_at: string | null;
          staff: { id: string; display_name: string; avatar_url: string | null; position: string | null } | null;
        }>;
        const assignedStaff = staffLinks
          .filter((s) => s.status === "accepted" && s.staff)
          .map((s) => ({ id: s.staff!.id, display_name: s.staff!.display_name, avatar_url: s.staff!.avatar_url }));

        // Full per-assignment detail (all statuses) for the Team tab — distinct
        // from assigned_staff above, which stays accepted-only for backward
        // compatibility with existing catalogue-card consumers.
        const team = staffLinks
          .filter((s) => s.staff)
          .map((s) => ({
            staff_id: s.staff!.id,
            display_name: s.staff!.display_name,
            avatar_url: s.staff!.avatar_url,
            position: s.staff!.position,
            status: s.status,
            role: s.role,
            effective_date: s.effective_date,
            offered_commission_type: s.offered_commission_type,
            offered_commission_value: s.offered_commission_value,
            assigned_at: s.assigned_at,
            responded_at: s.responded_at,
          }));

        const productLinks = (r.service_product_usage ?? []) as Array<{
          product: { current_stock: number; min_stock_alert: number | null } | null;
        }>;
        const linkedProducts = productLinks.filter((p) => p.product);
        // Same one-line low-stock comparison products/index.ts already uses —
        // not a new formula, just applied across a service's linked products.
        const hasLowStock = linkedProducts.some(
          (p) => p.product!.min_stock_alert !== null && p.product!.current_stock <= p.product!.min_stock_alert,
        );

        const { staff_services: _ss, service_product_usage: _spu, category: _cat, ...rest } = r;
        return {
          ...rest,
          category_name: category?.name ?? null,
          assigned_staff: assignedStaff,
          team,
          product_count: linkedProducts.length,
          has_low_stock: hasLowStock,
        };
      });

      return jsonCors(req, rows);
    }

    if (method === "POST" && action !== "duplicate") {
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

      // Draft rows are never publicly bookable regardless of what the client
      // sends — forced server-side, not just guarded in the wizard UI, so a
      // draft can never accidentally satisfy get-storefront's
      // is_active=true AND is_public=true filter while incomplete.
      const status = body.status === "draft" ? "draft" : "active";
      const isActive = status === "draft"
        ? false
        : (body.is_active !== undefined ? Boolean(body.is_active) : true);

      const { data, error } = await supabaseAdmin
        .from("services")
        .insert({
          business_id: ctx.businessId,
          category_id: categoryId,
          name,
          description: (body.description as string | undefined)?.trim() || null,
          duration_minutes: durationMinutes,
          buffer_minutes: Math.max(0, Math.min(120, Number(body.buffer_minutes ?? 0))),
          price,
          currency_code: (body.currency_code as string | undefined) ?? "EUR",
          deposit_amount: depositAmount,
          status,
          is_active: isActive,
          is_public: body.is_public !== undefined
            ? Boolean(body.is_public)
            : true,
          image_url: (body.image_url as string | undefined) ?? null,
          image_url_2: (body.image_url_2 as string | undefined) ?? null,
          image_url_3: (body.image_url_3 as string | undefined) ?? null,
          display_order: Number(body.display_order ?? 0),
          staff_commission_type: (["percentage", "fixed"].includes(
            String(body.staff_commission_type ?? "none")
          ) ? String(body.staff_commission_type) : "none"),
          staff_commission_value: parseMoney(body.staff_commission_value ?? null),
          use_intake_form: Boolean(body.use_intake_form ?? false),
          auto_show_to_staff: body.auto_show_to_staff !== undefined
            ? Boolean(body.auto_show_to_staff)
            : true,
          requires_two_staff: Boolean(body.requires_two_staff ?? false),
          commission_split_pct: body.requires_two_staff
            ? Math.min(100, Math.max(0, Number(body.commission_split_pct ?? 50)))
            : 50,
        })
        .select(`
          id,
          business_id,
          category_id,
          name,
          description,
          duration_minutes,
          buffer_minutes,
          price,
          currency_code,
          deposit_amount,
          status,
          is_active,
          is_public,
          image_url,
          image_url_2,
          image_url_3,
          display_order,
          staff_commission_type,
          staff_commission_value,
          use_intake_form,
          auto_show_to_staff,
          requires_two_staff,
          commission_split_pct,
          created_at,
          updated_at,
          category:service_categories(name)
        `)
        .single();

      if (error) return serverError(error.message);

      const newServiceId = (data as Record<string, unknown>).id as string;

      // Auto-assign new service to every active staff member in the business.
      // Staff can be removed individually afterwards; the intent is that all
      // staff can perform any new service by default. Skipped for drafts —
      // no offers go out until the owner publishes (WEB-OWNER-SERVICES-01).
      if (status !== "draft") {
        const { data: activeStaff } = await supabaseAdmin
          .from("staff_profiles")
          .select("id")
          .eq("business_id", ctx.businessId)
          .eq("is_active", true);

        if (activeStaff && activeStaff.length > 0) {
          await supabaseAdmin
            .from("staff_services")
            .insert(
              (activeStaff as { id: string }[]).map((s) => ({
                staff_profile_id: s.id,
                service_id: newServiceId,
                status: "pending",
              })),
            );
          for (const s of activeStaff as { id: string }[]) {
            logServiceActivity({
              businessId: ctx.businessId,
              serviceId: newServiceId,
              actorUserId: ctx.userId,
              eventType: "offer_sent",
              payload: { staff_profile_id: s.id, auto_assigned: true },
            });
          }
        }
      }

      logServiceActivity({
        businessId: ctx.businessId,
        serviceId: newServiceId,
        actorUserId: ctx.userId,
        eventType: "service_created",
        payload: { name, status },
      });

      const category = (data as Record<string, unknown>).category as {
        name?: string;
      } | null;
      return jsonCors(req, {
        ...(data as Record<string, unknown>),
        category_name: category?.name ?? null,
      }, 201);
    }

    if (method === "POST" && action === "duplicate") {
      if (!id) return badRequest("id is required");

      const { data: source, error: sourceErr } = await supabaseAdmin
        .from("services")
        .select("*")
        .eq("id", id)
        .maybeSingle();

      if (sourceErr) return serverError(sourceErr.message);
      if (!source) return notFound("Service not found");

      const src = source as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, src.business_id as string);
      if (ctx instanceof Response) return ctx;

      // Duplicates never inherit staff assignments — the owner must
      // deliberately re-offer, avoiding surprise offer emails for staff who
      // never asked to be assigned to the new service.
      const { data: copy, error: copyErr } = await supabaseAdmin
        .from("services")
        .insert({
          business_id: ctx.businessId,
          category_id: src.category_id,
          name: `${src.name as string} (copy)`,
          description: src.description,
          duration_minutes: src.duration_minutes,
          buffer_minutes: src.buffer_minutes,
          price: src.price,
          currency_code: src.currency_code,
          deposit_amount: src.deposit_amount,
          status: "active",
          is_active: true,
          is_public: false,
          image_url: src.image_url,
          image_url_2: src.image_url_2,
          image_url_3: src.image_url_3,
          display_order: src.display_order,
          staff_commission_type: src.staff_commission_type,
          staff_commission_value: src.staff_commission_value,
          use_intake_form: src.use_intake_form,
          auto_show_to_staff: src.auto_show_to_staff,
          requires_two_staff: src.requires_two_staff,
          commission_split_pct: src.commission_split_pct,
        })
        .select(`
          id, business_id, category_id, name, description,
          duration_minutes, buffer_minutes, price, currency_code,
          deposit_amount, status, is_active, is_public, image_url,
          image_url_2, image_url_3, display_order,
          staff_commission_type, staff_commission_value,
          use_intake_form, auto_show_to_staff,
          requires_two_staff, commission_split_pct,
          created_at, updated_at,
          category:service_categories(name)
        `)
        .single();

      if (copyErr) return serverError(copyErr.message);
      const newId = (copy as Record<string, unknown>).id as string;

      const { data: usageRows } = await supabaseAdmin
        .from("service_product_usage")
        .select("product_id, quantity_per_service")
        .eq("service_id", id);

      if (usageRows && usageRows.length > 0) {
        await supabaseAdmin
          .from("service_product_usage")
          .insert(
            (usageRows as { product_id: string; quantity_per_service: number }[]).map((u) => ({
              service_id: newId,
              product_id: u.product_id,
              quantity_per_service: u.quantity_per_service,
            })),
          );
      }

      logServiceActivity({
        businessId: ctx.businessId,
        serviceId: newId,
        actorUserId: ctx.userId,
        eventType: "service_created",
        payload: { duplicated_from: id },
      });

      const category = (copy as Record<string, unknown>).category as { name?: string } | null;
      return jsonCors(req, {
        ...(copy as Record<string, unknown>),
        category_name: category?.name ?? null,
      }, 201);
    }

    if (method === "PATCH") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("services")
        .select("id, business_id, status, is_active, is_public")
        .eq("id", id)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Service not found");

      const prev = existing as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, prev.business_id as string);
      if (ctx instanceof Response) return ctx;

      const updatePayload: Record<string, unknown> = {};

      if (body.name !== undefined) {
        const name = String(body.name ?? "").trim();
        if (!name) return badRequest("name cannot be empty");
        updatePayload.name = name;
      }

      if (body.description !== undefined) {
        updatePayload.description = String(body.description ?? "").trim() ||
          null;
      }

      if (body.duration_minutes !== undefined) {
        const duration = Number(body.duration_minutes);
        if (!Number.isFinite(duration) || duration <= 0) {
          return badRequest("duration_minutes must be a positive number");
        }
        updatePayload.duration_minutes = duration;
      }

      if (body.buffer_minutes !== undefined) {
        const buffer = Math.round(Number(body.buffer_minutes ?? 0));
        if (!Number.isFinite(buffer) || buffer < 0 || buffer > 120) {
          return badRequest("buffer_minutes must be between 0 and 120");
        }
        updatePayload.buffer_minutes = buffer;
      }

      if (body.price !== undefined) {
        const price = parseMoney(body.price);
        if (price === null || price <= 0) {
          return badRequest("price must be a positive number");
        }
        updatePayload.price = price;
      }

      if (body.deposit_amount !== undefined) {
        const depositAmount = parseMoney(body.deposit_amount);
        if (depositAmount !== null && depositAmount < 0) {
          return badRequest("deposit_amount must be >= 0");
        }
        updatePayload.deposit_amount = depositAmount;
      }

      // status: 'draft' -> 'active' is the wizard's Publish transition; the
      // reverse isn't supported (an active service doesn't go back to draft).
      if (body.status !== undefined) {
        if (body.status !== "active") {
          return badRequest("status can only be updated to 'active' (publish)");
        }
        if (prev.status === "draft") {
          updatePayload.status = "active";
        }
      }

      const publishing = updatePayload.status === "active";
      const stillDraft = prev.status === "draft" && !publishing;

      if (body.is_active !== undefined) {
        // A draft can never be flipped to publicly bookable except via the
        // explicit publish transition above — defense in depth beyond the
        // wizard's own guard, so get-storefront's existing is_active AND
        // is_public filter stays sufficient with no changes to that function.
        updatePayload.is_active = stillDraft ? false : Boolean(body.is_active);
      } else if (stillDraft) {
        updatePayload.is_active = false;
      }
      if (body.is_public !== undefined) {
        updatePayload.is_public = Boolean(body.is_public);
      }
      if (body.image_url !== undefined) {
        const imageUrl = String(body.image_url ?? "").trim();
        updatePayload.image_url = imageUrl || null;
      }
      if (body.image_url_2 !== undefined) {
        const imageUrl2 = String(body.image_url_2 ?? "").trim();
        updatePayload.image_url_2 = imageUrl2 || null;
      }
      if (body.image_url_3 !== undefined) {
        const imageUrl3 = String(body.image_url_3 ?? "").trim();
        updatePayload.image_url_3 = imageUrl3 || null;
      }
      if (body.display_order !== undefined) {
        updatePayload.display_order = Number(body.display_order);
      }

      if (body.category_id !== undefined || body.category_name !== undefined) {
        updatePayload.category_id = await resolveCategoryId(
          ctx.businessId,
          (body.category_name as string | undefined) ?? null,
          (body.category_id as string | undefined) ?? null,
        );
      }

      if (body.staff_commission_type !== undefined) {
        const ct = String(body.staff_commission_type ?? "none");
        if (!["none", "percentage", "fixed"].includes(ct)) {
          return badRequest("staff_commission_type must be none, percentage, or fixed");
        }
        updatePayload.staff_commission_type = ct;
        if (ct === "none") updatePayload.staff_commission_value = null;
      }

      if (body.staff_commission_value !== undefined) {
        updatePayload.staff_commission_value = parseMoney(body.staff_commission_value) ?? null;
      }

      if (body.use_intake_form !== undefined) {
        updatePayload.use_intake_form = Boolean(body.use_intake_form);
      }

      if (body.auto_show_to_staff !== undefined) {
        updatePayload.auto_show_to_staff = Boolean(body.auto_show_to_staff);
      }

      if (body.requires_two_staff !== undefined) {
        updatePayload.requires_two_staff = Boolean(body.requires_two_staff);
      }

      if (body.commission_split_pct !== undefined) {
        const split = Number(body.commission_split_pct);
        if (!Number.isFinite(split) || split < 0 || split > 100) {
          return badRequest("commission_split_pct must be between 0 and 100");
        }
        updatePayload.commission_split_pct = Math.round(split * 100) / 100;
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
          buffer_minutes,
          price,
          currency_code,
          deposit_amount,
          status,
          is_active,
          is_public,
          image_url,
          image_url_2,
          image_url_3,
          display_order,
          staff_commission_type,
          staff_commission_value,
          use_intake_form,
          auto_show_to_staff,
          requires_two_staff,
          commission_split_pct,
          created_at,
          updated_at,
          category:service_categories(name)
        `)
        .single();

      if (error) return serverError(error.message);

      // One diff-derived event per meaningful transition — keeps the Activity
      // tab readable instead of logging every PATCH as an undifferentiated
      // "service_updated".
      let eventType: "archived" | "restored" | "visibility_changed" | "service_updated" = "service_updated";
      if (updatePayload.is_active === false && prev.is_active !== false) {
        eventType = "archived";
      } else if (updatePayload.is_active === true && prev.is_active === false) {
        eventType = "restored";
      } else if (updatePayload.is_public !== undefined && updatePayload.is_public !== prev.is_public) {
        eventType = "visibility_changed";
      }
      logServiceActivity({
        businessId: ctx.businessId,
        serviceId: id,
        actorUserId: ctx.userId,
        eventType,
        payload: { fields: Object.keys(updatePayload) },
      });

      const category = (data as Record<string, unknown>).category as {
        name?: string;
      } | null;
      return jsonCors(req, {
        ...(data as Record<string, unknown>),
        category_name: category?.name ?? null,
      });
    }

    if (method === "DELETE") {
      if (!id) return badRequest("id is required");

      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("services")
        .select("id, business_id, name")
        .eq("id", id)
        .maybeSingle();

      if (existingErr) return serverError(existingErr.message);
      if (!existing) return notFound("Service not found");

      const prev = existing as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, prev.business_id as string);
      if (ctx instanceof Response) return ctx;

      // Checked explicitly rather than relying solely on a FK violation:
      // appointments.service_id is ON DELETE SET NULL (a single-service
      // booking's header row survives service deletion by design), so only
      // multi-service appointment_services rows (ON DELETE RESTRICT) would
      // ever actually block the delete at the DB level. Any appointment
      // history — single- or multi-service — must block delete per product
      // decision, so both are checked here instead of trusting the FK alone.
      const [apptCheck, apptSvcCheck] = await Promise.all([
        supabaseAdmin.from("appointments").select("id", { count: "exact", head: true }).eq("service_id", id),
        supabaseAdmin.from("appointment_services").select("id", { count: "exact", head: true }).eq("service_id", id),
      ]);
      if (apptCheck.error) return serverError(apptCheck.error.message);
      if (apptSvcCheck.error) return serverError(apptSvcCheck.error.message);
      if ((apptCheck.count ?? 0) > 0 || (apptSvcCheck.count ?? 0) > 0) {
        return conflict(req, "HAS_APPOINTMENT_HISTORY", "This service has appointment history and cannot be deleted. Archive it instead.");
      }

      const { error } = await supabaseAdmin
        .from("services")
        .delete()
        .eq("id", id)
        .eq("business_id", ctx.businessId);

      if (error) {
        // Belt-and-suspenders: appointment_services' RESTRICT FK would still
        // catch a race (a booking created between the check above and this
        // delete), surfaced the same way as the explicit check.
        if ((error as { code?: string }).code === "23503") {
          return conflict(req, "HAS_APPOINTMENT_HISTORY", "This service has appointment history and cannot be deleted. Archive it instead.");
        }
        return serverError(error.message);
      }

      // No activity-log entry here: service_activity_log.service_id is
      // ON DELETE CASCADE from services, so the row is gone the instant the
      // delete succeeds — there is nothing left to log against.
      return jsonCors(req, { ok: true });
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("services error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
