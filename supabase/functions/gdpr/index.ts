import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, notFound, serverError } from "../_shared/errors.ts";
import { verifyAuth, requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// GDPR — Data Export + Anonymisation
//
// GET  /gdpr?action=export
//   Auth: verifyAuth (client requesting their own data)
//   Returns client record + appointment history + payments — no business-private fields.
//
// DELETE /gdpr?action=delete
//   Auth: requireOwnerOrManagerCtx (owner deleting a client)
//        OR verifyAuth (client requesting self-deletion)
//   Anonymises the client row in place — NEVER hard deletes.
//   Appointment and payment rows are preserved for financial compliance.
// ---------------------------------------------------------------------------

Deno.serve(withLogging("gdpr", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (!action) return badRequest("action query param is required (export | delete)");
  if (!["export", "delete"].includes(action)) {
    return badRequest("action must be 'export' or 'delete'");
  }

  try {
    // ── GET /gdpr?action=export ─────────────────────────────────────────────
    if (req.method === "GET" && action === "export") {
      // Client authenticates with their own JWT
      const user = await verifyAuth(req).catch((e: unknown) => {
        if (e instanceof Response) throw e;
        throw e;
      });

      // Find the client record by user_id (could span multiple businesses)
      const { data: clients, error: clientErr } = await supabaseAdmin
        .from("clients")
        .select("id, business_id, first_name, last_name, email, phone, gdpr_consent, gdpr_consent_at")
        .eq("user_id", user.id);

      if (clientErr) return serverError(clientErr.message);
      if (!clients || clients.length === 0) {
        return notFound("No client record found for this account");
      }

      // Export all data across all businesses this client belongs to
      const clientIds = clients.map((c: Record<string, unknown>) => c.id as string);

      const [appointmentsResult, paymentsResult] = await Promise.all([
        supabaseAdmin
          .from("appointments")
          .select(`
            id,
            starts_at,
            status,
            price,
            booking_reference,
            services ( name ),
            staff_profiles ( display_name )
          `)
          .in("client_id", clientIds)
          .order("starts_at", { ascending: false }),

        supabaseAdmin
          .from("payments")
          .select("id, amount, currency_code, status, paid_at, method, provider")
          .in("client_id", clientIds)
          .order("paid_at", { ascending: false }),
      ]);

      if (appointmentsResult.error) return serverError(appointmentsResult.error.message);
      if (paymentsResult.error) return serverError(paymentsResult.error.message);

      const appointments = (appointmentsResult.data ?? []).map((a: Record<string, unknown>) => {
        const row = a;
        const service = row.services as { name?: string } | null;
        const staff = row.staff_profiles as { display_name?: string } | null;
        return {
          id: row.id,
          starts_at: row.starts_at,
          booking_reference: row.booking_reference,
          service_name: service?.name ?? null,
          staff_name: staff?.display_name ?? null,
          status: row.status,
          price: row.price,
        };
      });

      const payments = (paymentsResult.data ?? []).map((p: Record<string, unknown>) => {
        const row = p;
        return {
          id: row.id,
          amount: row.amount,
          currency: row.currency_code,
          status: row.status,
          paid_at: row.paid_at ?? null,
          provider: (row.provider as string | null) ?? (row.method as string) ?? null,
        };
      });

      // Return the first client record's fields as the canonical profile
      // (most clients belong to only one business)
      const primaryClient = clients[0] as Record<string, unknown>;

      return json({
        exportedAt: new Date().toISOString(),
        client: {
          id: primaryClient.id,
          first_name: primaryClient.first_name,
          last_name: primaryClient.last_name,
          email: primaryClient.email ?? null,
          phone: primaryClient.phone ?? null,
          gdpr_consent: primaryClient.gdpr_consent,
          gdpr_consent_at: primaryClient.gdpr_consent_at ?? null,
        },
        appointments,
        payments,
      });
    }

    // ── DELETE /gdpr?action=delete ──────────────────────────────────────────
    if (req.method === "DELETE" && action === "delete") {
      // Two auth modes:
      //  1. Owner/manager provides { business_id, client_id } in body
      //  2. Client self-deletes using their own JWT (no business_id needed)
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;

      const businessId = body.business_id as string | undefined;

      let clientId: string | undefined;
      let isOwnerRequest = false;

      if (businessId) {
        // Owner-initiated deletion
        const ctx = await requireOwnerOrManagerCtx(req, businessId);
        if (ctx instanceof Response) return ctx;

        clientId = body.client_id as string | undefined;
        if (!clientId) return badRequest("client_id is required when business_id is provided");

        // Verify client belongs to the authenticated business
        const { data: clientRow, error: checkErr } = await supabaseAdmin
          .from("clients")
          .select("id")
          .eq("id", clientId)
          .eq("business_id", ctx.businessId)
          .maybeSingle();

        if (checkErr) return serverError(checkErr.message);
        if (!clientRow) return notFound("Client not found in this business");

        isOwnerRequest = true;
      } else {
        // Client self-deletion — derive client_id from JWT
        const user = await verifyAuth(req).catch((e: unknown) => {
          if (e instanceof Response) throw e;
          throw e;
        });

        // Find ALL client records for this user (across businesses)
        // Use provided client_id if given, otherwise delete all their records
        let lookupQuery = supabaseAdmin
          .from("clients")
          .select("id")
          .eq("user_id", user.id);

        if (body.client_id) {
          lookupQuery = lookupQuery.eq("id", body.client_id as string);
        }

        const { data: clientRows, error: lookupErr } = await lookupQuery;
        if (lookupErr) return serverError(lookupErr.message);
        if (!clientRows || clientRows.length === 0) {
          return notFound("No client record found for this account");
        }

        // Anonymise all their records
        const idsToAnonymise = clientRows.map((c: Record<string, unknown>) => c.id as string);
        const now = new Date().toISOString();

        for (const id of idsToAnonymise) {
          const { error: anonErr } = await supabaseAdmin
            .from("clients")
            .update({
              first_name: "[DELETED]",
              last_name: "[DELETED]",
              email: `deleted+${id}@gdpr.kazione.com`,
              phone: null,
              gdpr_consent: false,
              gdpr_consent_at: null,
              marketing_opt_in: false,
            })
            .eq("id", id);

          if (anonErr) return serverError(anonErr.message);
        }

        return json({ success: true, anonymisedAt: now });
      }

      // Owner-initiated anonymisation for a single client_id
      if (isOwnerRequest && clientId) {
        const now = new Date().toISOString();

        const { error: anonErr } = await supabaseAdmin
          .from("clients")
          .update({
            first_name: "[DELETED]",
            last_name: "[DELETED]",
            email: `deleted+${clientId}@gdpr.kazione.com`,
            phone: null,
            gdpr_consent: false,
            gdpr_consent_at: null,
            marketing_opt_in: false,
          })
          .eq("id", clientId);

        if (anonErr) return serverError(anonErr.message);

        return json({ success: true, anonymisedAt: now });
      }

      return badRequest("Unable to process deletion request");
    }

    return badRequest(`Method ${req.method} with action=${action} is not supported`);
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[gdpr] Unhandled error:", err);
    return serverError(err instanceof Error ? err.message : "Internal server error");
  }
}));
