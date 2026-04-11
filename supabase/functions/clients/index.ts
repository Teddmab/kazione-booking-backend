import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, conflict, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * /clients — clients CRUD + bulk import
 *
 * GET  ?business_id=&[page=&limit=&search=&tags=]   → paginated list with stats
 * GET  ?id=                                          → single client with recent appointments
 * POST                                               → create client (body: business_id + fields)
 * POST ?action=import                                → bulk import (body: business_id, rows:[])
 * PATCH ?id=                                         → update client fields (body: partial fields)
 */
Deno.serve(withLogging("clients", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const method = req.method;
  const action = url.searchParams.get("action");
  const id = url.searchParams.get("id");

  try {
    // ── GET ────────────────────────────────────────────────────────────────
    if (method === "GET") {
      if (id) {
        // Single client — first verify the requesting user is a business member
        const { data: client, error } = await supabaseAdmin
          .from("clients")
          .select(`*, preferred_staff:staff_profiles!clients_preferred_staff_id_fkey(id, display_name, avatar_url)`)
          .eq("id", id)
          .single();

        if (error) {
          return error.code === "PGRST116" ? notFound("Client not found") : serverError(error.message);
        }

        // Auth: must be member of the client's business
        try {
          const user = await verifyAuth(req);
          await verifyBusinessMember(user.id, (client as Record<string, unknown>).business_id as string);
        } catch (e) {
          if (e instanceof Response) return e;
          throw e;
        }

        const { data: appointments } = await supabaseAdmin
          .from("appointments")
          .select(`id, starts_at, ends_at, status, booking_reference, price,
            service:services!inner(id, name, duration_minutes, price),
            staff:staff_profiles(id, display_name, avatar_url),
            payment:payments(status, amount, method, paid_at)`)
          .eq("client_id", id)
          .order("starts_at", { ascending: false })
          .limit(10);

        const recentAppointments = (appointments ?? []).map((row: Record<string, unknown>) => ({
          ...row,
          payment: (row.payment as unknown[])?.[0] ?? null,
        }));

        return json({ ...client, recent_appointments: recentAppointments });
      }

      const businessId = url.searchParams.get("business_id");
      if (!businessId) return badRequest("business_id is required");

      try {
        const user = await verifyAuth(req);
        await verifyBusinessMember(user.id, businessId);
      } catch (e) {
        if (e instanceof Response) return e;
        throw e;
      }

      const page = parseInt(url.searchParams.get("page") ?? "1", 10);
      const limit = parseInt(url.searchParams.get("limit") ?? "25", 10);
      const search = url.searchParams.get("search");
      const tags = url.searchParams.getAll("tags");

      // deno-lint-ignore no-explicit-any
      let query: any = supabaseAdmin
        .from("clients")
        .select(`*, appointments(id, starts_at, status, price)`, { count: "exact" })
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });

      if (search) {
        query = query.or(
          `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%,phone.ilike.%${search}%`,
        );
      }
      if (tags?.length) {
        query = query.overlaps("tags", tags);
      }

      const from = (page - 1) * limit;
      query = query.range(from, from + limit - 1);

      const { data, error, count } = await query;
      if (error) return serverError(error.message);

      const clients = (data ?? []).map((row: Record<string, unknown>) => {
        const appts = (row.appointments as { id: string; starts_at: string; status: string; price: number }[]) ?? [];
        const completed = appts.filter((a) => a.status === "completed");
        const { appointments: _, ...fields } = row;
        return {
          ...fields,
          appointment_count: appts.length,
          last_visit: completed.length > 0
            ? completed.sort((a, b) => new Date(b.starts_at).getTime() - new Date(a.starts_at).getTime())[0].starts_at
            : null,
          total_spent: completed.reduce((sum, a) => sum + a.price, 0),
        };
      });

      return json({ clients, total: count ?? 0 });
    }

    // ── POST ───────────────────────────────────────────────────────────────
    if (method === "POST") {
      const body = await req.json() as Record<string, unknown>;

      if (action === "import") {
        const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
        if (ctx instanceof Response) return ctx;

        const rows = body.rows as Record<string, unknown>[];
        let imported = 0, updated = 0, skipped = 0;
        const errors: { row: number; reason: string }[] = [];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (!row.first_name || !row.last_name) {
            errors.push({ row: i + 1, reason: "Missing first_name or last_name" });
            skipped++;
            continue;
          }

          try {
            if (row.email) {
              const { data: existing } = await supabaseAdmin
                .from("clients")
                .select("id")
                .eq("business_id", ctx.businessId)
                .eq("email", row.email as string)
                .maybeSingle();

              if (existing) {
                const { error: updateErr } = await supabaseAdmin
                  .from("clients")
                  .update({ first_name: row.first_name, last_name: row.last_name, phone: row.phone ?? undefined, date_of_birth: row.date_of_birth ?? undefined, notes: row.notes ?? undefined, tags: row.tags ?? undefined })
                  .eq("id", (existing as Record<string, unknown>).id as string);

                if (updateErr) { errors.push({ row: i + 1, reason: updateErr.message }); skipped++; }
                else updated++;
                continue;
              }
            }

            const { error: insertErr } = await supabaseAdmin.from("clients").insert({
              business_id: ctx.businessId,
              first_name: row.first_name,
              last_name: row.last_name,
              email: row.email ?? null,
              phone: row.phone ?? null,
              date_of_birth: row.date_of_birth ?? null,
              notes: row.notes ?? null,
              tags: row.tags ?? [],
              source: row.source ?? "import",
            });

            if (insertErr) { errors.push({ row: i + 1, reason: insertErr.message }); skipped++; }
            else imported++;
          } catch (err) {
            errors.push({ row: i + 1, reason: err instanceof Error ? err.message : "Unknown error" });
            skipped++;
          }
        }

        return json({ imported, updated, skipped, errors });
      }

      // Create client
      const ctx = await requireOwnerOrManagerCtx(req, body.business_id as string);
      if (ctx instanceof Response) return ctx;

      if (body.email) {
        const { data: existing } = await supabaseAdmin
          .from("clients")
          .select("id")
          .eq("business_id", ctx.businessId)
          .eq("email", body.email as string)
          .maybeSingle();

        if (existing) {
          return conflict("EMAIL_TAKEN", `A client with email ${body.email} already exists`);
        }
      }

      const { data: client, error } = await supabaseAdmin
        .from("clients")
        .insert({
          business_id: ctx.businessId,
          first_name: body.first_name,
          last_name: body.last_name,
          email: body.email ?? null,
          phone: body.phone ?? null,
          date_of_birth: body.date_of_birth ?? null,
          notes: body.notes ?? null,
          tags: body.tags ?? [],
          preferred_staff_id: body.preferred_staff_id ?? null,
          preferred_locale: body.preferred_locale ?? "en",
          source: body.source ?? "manual",
        })
        .select("*")
        .single();

      if (error) return serverError(error.message);
      return json(client, 201);
    }

    // ── PATCH ──────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (!id) return badRequest("id is required");
      const body = await req.json() as Record<string, unknown>;

      // Fetch client to get business_id for auth
      const { data: existing, error: fetchErr } = await supabaseAdmin
        .from("clients")
        .select("business_id")
        .eq("id", id)
        .single();

      if (fetchErr || !existing) return notFound("Client not found");

      const ctx = await requireOwnerOrManagerCtx(req, (existing as Record<string, unknown>).business_id as string);
      if (ctx instanceof Response) return ctx;

      const { data: client, error } = await supabaseAdmin
        .from("clients")
        .update(body)
        .eq("id", id)
        .select("*")
        .single();

      if (error) return serverError(error.message);
      return json(client);
    }

    return badRequest("Method not allowed");
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("clients error:", err);
    return serverError(err instanceof Error ? err.message : "Internal error");
  }
}));
