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
// GDPR — Data Export + Erasure
//
// GET  /gdpr?action=export
//   Auth: verifyAuth (client requesting their own data)
//   Returns client record + appointment history + payments — no business-private fields.
//
// DELETE /gdpr                          ← GDPR Article 17 — right to erasure (client self-service)
//   Body: { confirm: true }
//   Auth: verifyAuth (client deletes their own account)
//   Hard deletes: appointment_status_log → appointments → clients → auth user
//
// DELETE /gdpr?action=delete            ← Owner-initiated anonymisation
//   Body: { business_id, client_id }
//   Auth: requireOwnerOrManagerCtx
//   Anonymises PII in-place — preserves appointment rows for financial compliance.
// ---------------------------------------------------------------------------

Deno.serve(withLogging("gdpr", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    // ── GET /gdpr?action=export ─────────────────────────────────────────────
    if (req.method === "GET") {
      if (action !== "export") {
        return badRequest("action must be 'export' for GET requests");
      }

      const user = await verifyAuth(req).catch((e: unknown) => {
        if (e instanceof Response) throw e;
        throw e;
      });

      const { data: clients, error: clientErr } = await supabaseAdmin
        .from("clients")
        .select("id, business_id, first_name, last_name, email, phone, gdpr_consent, gdpr_consent_at")
        .eq("user_id", user.id);

      if (clientErr) return serverError(clientErr.message);
      if (!clients || clients.length === 0) {
        return notFound("No client record found for this account");
      }

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
        const service = a.services as { name?: string } | null;
        const staff = a.staff_profiles as { display_name?: string } | null;
        return {
          id: a.id,
          starts_at: a.starts_at,
          booking_reference: a.booking_reference,
          service_name: service?.name ?? null,
          staff_name: staff?.display_name ?? null,
          status: a.status,
          price: a.price,
        };
      });

      const payments = (paymentsResult.data ?? []).map((p: Record<string, unknown>) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency_code,
        status: p.status,
        paid_at: p.paid_at ?? null,
        provider: (p.provider as string | null) ?? (p.method as string) ?? null,
      }));

      const primaryClient = clients[0] as Record<string, unknown>;

      return json({
        exported_at: new Date().toISOString(),
        profile: {
          first_name: primaryClient.first_name,
          last_name: primaryClient.last_name,
          email: primaryClient.email ?? null,
          phone: primaryClient.phone ?? null,
        },
        appointments,
        payments,
        consents: {
          gdpr_consent: primaryClient.gdpr_consent,
          gdpr_consent_at: primaryClient.gdpr_consent_at ?? null,
        },
      });
    }

    // ── DELETE /gdpr — client self-erasure (GDPR Article 17) ───────────────
    if (req.method === "DELETE" && !action) {
      const user = await verifyAuth(req).catch((e: unknown) => {
        if (e instanceof Response) throw e;
        throw e;
      });

      const body = await req.json().catch(() => ({})) as Record<string, unknown>;

      if (body.confirm !== true) {
        return badRequest("Request body must include { confirm: true } to proceed with account deletion");
      }

      // Find all client records for this user
      const { data: clientRows, error: lookupErr } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("user_id", user.id);

      if (lookupErr) return serverError(lookupErr.message);
      if (!clientRows || clientRows.length === 0) {
        return notFound("No client record found for this account");
      }

      const clientIds = clientRows.map((c: Record<string, unknown>) => c.id as string);

      // Fetch appointment IDs before deletion (needed for status log cleanup)
      const { data: apptRows, error: apptLookupErr } = await supabaseAdmin
        .from("appointments")
        .select("id")
        .in("client_id", clientIds);

      if (apptLookupErr) return serverError(apptLookupErr.message);
      const appointmentIds = (apptRows ?? []).map((a: Record<string, unknown>) => a.id as string);

      console.log(`[gdpr] DELETION initiated — user_id=${user.id} clients=${clientIds.length} appointments=${appointmentIds.length}`);

      // Delete in dependency order
      if (appointmentIds.length > 0) {
        const { error: logErr } = await supabaseAdmin
          .from("appointment_status_log")
          .delete()
          .in("appointment_id", appointmentIds);
        if (logErr) return serverError(`Failed to delete status log: ${logErr.message}`);
      }

      if (clientIds.length > 0) {
        const { error: apptErr } = await supabaseAdmin
          .from("appointments")
          .delete()
          .in("client_id", clientIds);
        if (apptErr) return serverError(`Failed to delete appointments: ${apptErr.message}`);

        const { error: clientErr } = await supabaseAdmin
          .from("clients")
          .delete()
          .in("id", clientIds);
        if (clientErr) return serverError(`Failed to delete client records: ${clientErr.message}`);
      }

      // Delete the auth account last — after this, the JWT is invalidated
      const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(user.id);
      if (authErr) return serverError(`Failed to delete auth account: ${authErr.message}`);

      console.log(`[gdpr] DELETION complete — user_id=${user.id}`);

      return json({
        deleted: true,
        message: "Your account and all associated data have been permanently deleted.",
      });
    }

    // ── DELETE /gdpr?action=delete — owner-initiated anonymisation ──────────
    if (req.method === "DELETE" && action === "delete") {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const businessId = body.business_id as string | undefined;

      if (!businessId) {
        return badRequest("business_id is required for owner-initiated deletion");
      }

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const clientId = body.client_id as string | undefined;
      if (!clientId) return badRequest("client_id is required when business_id is provided");

      const { data: clientRow, error: checkErr } = await supabaseAdmin
        .from("clients")
        .select("id")
        .eq("id", clientId)
        .eq("business_id", ctx.businessId)
        .maybeSingle();

      if (checkErr) return serverError(checkErr.message);
      if (!clientRow) return notFound("Client not found in this business");

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

      return json({ success: true, anonymised_at: now });
    }

    return badRequest(`Method ${req.method}${action ? ` with action=${action}` : ""} is not supported`);
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[gdpr] Unhandled error:", err);
    return serverError(err instanceof Error ? err.message : "Internal server error");
  }
}));
