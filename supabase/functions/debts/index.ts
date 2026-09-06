import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors, jsonCors } from "../_shared/cors.ts";
import { badRequest, forbidden, notFound, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx, verifyAuth, verifyBusinessMember } from "../_shared/auth.ts";
import { checkMonthNotLocked } from "../_shared/financialPeriods.ts";

const VALID_CATEGORIES = ["tax", "rent", "utilities", "bank_loan", "supplier", "equipment", "other"];
const VALID_STATUSES   = ["active", "paid_off", "disputed", "restructured"];
const VALID_PRIORITIES = ["critical", "high", "medium", "low"];
const VALID_CREDITOR_TYPES = ["supplier", "business", "person"];

// Local Supabase (Docker/kong) signs storage URLs with an internal hostname
// the browser can't reach — rewrite to 127.0.0.1 outside of production.
function rewriteLocalUrl(u: string): string {
  const internalUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const isLocal = internalUrl.includes("kong") || internalUrl.includes("supabase_");
  if (!isLocal) return u;
  return u.replace(/^https?:\/\/[^/]+(?=\/storage\/)/, "http://127.0.0.1:54321");
}

function dayOffset(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function extFromMime(mime: string | null | undefined): string {
  if (!mime) return "bin";
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("heic")) return "heic";
  return "jpg";
}

async function uploadDebtFile(businessId: string, subfolder: string, base64: string, mimeType: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const path = `${businessId}/${subfolder}/${crypto.randomUUID()}.${extFromMime(mimeType)}`;
  const { error } = await supabaseAdmin.storage
    .from("debt-documents")
    .upload(path, bytes, { contentType: mimeType || "application/octet-stream" });
  if (error) throw new Error(error.message);
  return path;
}

// Fire-and-forget internal call to send-email — a delivery failure here must
// never fail the payment recording itself, so callers just log and move on.
const FUNCTIONS_URL = Deno.env.get("SUPABASE_URL") + "/functions/v1";
const INTERNAL_KEY = Deno.env.get("INTERNAL_FUNCTION_KEY") ?? "";

async function sendEmailInternal(to: string, template: string, data: Record<string, string>): Promise<void> {
  try {
    const res = await fetch(`${FUNCTIONS_URL}/send-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-key": INTERNAL_KEY },
      body: JSON.stringify({ to, template, data }),
    });
    if (!res.ok) console.error(`[debts] send-email failed for ${to}: ${res.status} ${await res.text()}`);
  } catch (err) {
    console.error(`[debts] send-email request failed for ${to}:`, err);
  }
}

const SUPPLIER_SELECT = "supplier:suppliers(id, name, email, phone)";

/**
 * /debts — business debt register + payment log
 *
 * GET  ?business_id=[&status=active][&include_archived=true] → list debts (priority order: critical first)
 * GET  ?id=                                       → single debt
 * GET  ?action=summary&business_id=               → totals, counts, overdue
 * GET  ?action=payments&debt_id=                  → payment history for one debt
 * GET  ?action=documents&debt_id=                 → debt's documents & notes
 * POST body={business_id,...}                     → create debt
 * POST ?action=record-payment body={...}          → log payment, reduce balance
 * POST ?action=document body={business_id,debt_id,kind,...} → add a document or note
 * PATCH ?id= body={...fields}                     → update debt (incl. reference, is_archived)
 * DELETE ?id=                                     → delete debt (cascades payments)
 * DELETE ?action=document&id=                     → delete a document or note
 */
Deno.serve(withLogging("debts", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  const url    = new URL(req.url);
  const method = req.method;
  const id     = url.searchParams.get("id");
  const action = url.searchParams.get("action");

  try {
    // ── GET ──────────────────────────────────────────────────────────────────
    if (method === "GET") {
      const businessId = url.searchParams.get("business_id");
      const debtId     = url.searchParams.get("debt_id");

      // GET payments for a specific debt
      if (action === "payments") {
        if (!debtId) return badRequest("debt_id is required");

        let user;
        try { user = await verifyAuth(req); } catch (e) { return e instanceof Response ? e : forbidden("Auth required"); }

        // resolve business_id from the debt row
        const { data: debt } = await supabaseAdmin
          .from("business_debts")
          .select("business_id")
          .eq("id", debtId)
          .maybeSingle();
        if (!debt) return notFound("Debt not found");

        try { await verifyBusinessMember(user.id, (debt as Record<string,unknown>).business_id as string); }
        catch (e) { return e instanceof Response ? e : forbidden("Access denied"); }

        const { data: payments, error } = await supabaseAdmin
          .from("debt_payments")
          .select("id, debt_id, amount, fee, payment_date, payment_method, reference, receipt_url, notes, created_at, recorded_by:users!debt_payments_created_by_fkey(id, first_name, last_name)")
          .eq("debt_id", debtId)
          .order("payment_date", { ascending: false });

        if (error) return serverError(error.message);

        // Which of these payments were linked from a reconciled bank
        // transaction (vs. entered by hand) — surfaced so the UI can flag
        // possible duplicates more confidently for that origin, per a
        // reported pattern of the same real-world payment getting both a
        // manual entry and a separate bank-match entry.
        const paymentIds = (payments ?? []).map((p) => (p as Record<string, unknown>).id as string);
        const { data: bankMatches } = paymentIds.length > 0
          ? await supabaseAdmin
              .from("bank_transactions")
              .select("reconciled_debt_payment_id")
              .in("reconciled_debt_payment_id", paymentIds)
          : { data: [] as { reconciled_debt_payment_id: string }[] };
        const bankMatchedIds = new Set((bankMatches ?? []).map((r) => r.reconciled_debt_payment_id));

        const withUrls = await Promise.all((payments ?? []).map(async (row: Record<string, unknown>) => {
          const from_bank_match = bankMatchedIds.has(row.id as string);
          if (!row.receipt_url) return { ...row, receipt_url: null, from_bank_match };
          const { data: signed } = await supabaseAdmin.storage
            .from("debt-documents")
            .createSignedUrl(row.receipt_url as string, 3600);
          return { ...row, receipt_url: signed?.signedUrl ? rewriteLocalUrl(signed.signedUrl) : null, from_bank_match };
        }));

        return jsonCors(req, { payments: withUrls });
      }

      // GET documents & notes for a specific debt
      if (action === "documents") {
        if (!debtId) return badRequest("debt_id is required");

        let user;
        try { user = await verifyAuth(req); } catch (e) { return e instanceof Response ? e : forbidden("Auth required"); }

        const { data: debt } = await supabaseAdmin
          .from("business_debts")
          .select("business_id")
          .eq("id", debtId)
          .maybeSingle();
        if (!debt) return notFound("Debt not found");

        try { await verifyBusinessMember(user.id, (debt as Record<string,unknown>).business_id as string); }
        catch (e) { return e instanceof Response ? e : forbidden("Access denied"); }

        const { data, error } = await supabaseAdmin
          .from("debt_documents")
          .select("*, author:users!debt_documents_created_by_fkey(id, first_name, last_name)")
          .eq("debt_id", debtId)
          .order("created_at", { ascending: false });

        if (error) return serverError(error.message);

        const documents = await Promise.all((data ?? []).map(async (row: Record<string, unknown>) => {
          if (!row.file_path) return { ...row, file_url: null };
          const { data: signed } = await supabaseAdmin.storage
            .from("debt-documents")
            .createSignedUrl(row.file_path as string, 3600);
          return { ...row, file_url: signed?.signedUrl ? rewriteLocalUrl(signed.signedUrl) : null };
        }));

        return jsonCors(req, { documents });
      }

      // GET single debt
      if (id) {
        let user;
        try { user = await verifyAuth(req); } catch (e) { return e instanceof Response ? e : forbidden("Auth required"); }

        const { data: debt, error } = await supabaseAdmin
          .from("business_debts")
          .select(`*, ${SUPPLIER_SELECT}`)
          .eq("id", id)
          .maybeSingle();

        if (error) return serverError(error.message);
        if (!debt) return notFound("Debt not found");

        try { await verifyBusinessMember(user.id, (debt as Record<string,unknown>).business_id as string); }
        catch (e) { return e instanceof Response ? e : forbidden("Access denied"); }

        return jsonCors(req, debt);
      }

      if (!businessId) return badRequest("business_id is required");

      try {
        const user = await verifyAuth(req);
        await verifyBusinessMember(user.id, businessId);
      } catch (e) {
        return e instanceof Response ? e : forbidden("Auth required");
      }

      // GET summary (totals + overdue count) — archived debts are excluded
      if (action === "summary") {
        const { data: debts, error } = await supabaseAdmin
          .from("business_debts")
          .select("current_balance, monthly_minimum, category, priority, due_date, status")
          .eq("business_id", businessId)
          .eq("is_archived", false);

        if (error) return serverError(error.message);

        const today = new Date().toISOString().slice(0, 10);
        const active = (debts ?? []).filter((d) => (d as Record<string,unknown>).status === "active");

        let total_owed = 0;
        let monthly_minimum_total = 0;
        let overdue_count = 0;
        let overdue_total = 0;
        const by_category: Record<string, number> = {};
        const by_priority: Record<string, number> = {};

        for (const d of active) {
          const row = d as Record<string, unknown>;
          const balance = Number(row.current_balance ?? 0);
          total_owed += balance;
          monthly_minimum_total += Number(row.monthly_minimum ?? 0);
          const cat = (row.category as string) ?? "other";
          by_category[cat] = (by_category[cat] ?? 0) + balance;
          const pri = (row.priority as string) ?? "medium";
          by_priority[pri] = (by_priority[pri] ?? 0) + balance;
          if (row.due_date && String(row.due_date) < today) { overdue_count++; overdue_total += balance; }
        }

        return jsonCors(req, {
          total_owed,
          monthly_minimum_total,
          overdue_count,
          overdue_total,
          active_count: active.length,
          by_category,
          by_priority,
        });
      }

      // GET list of debts — archived debts are excluded unless requested
      const statusFilter = url.searchParams.get("status");
      const includeArchived = url.searchParams.get("include_archived") === "true";
      let query = supabaseAdmin
        .from("business_debts")
        .select(`*, ${SUPPLIER_SELECT}`)
        .eq("business_id", businessId);

      if (!includeArchived) query = query.eq("is_archived", false);
      if (statusFilter && VALID_STATUSES.includes(statusFilter)) {
        query = query.eq("status", statusFilter);
      }

      // Sort: critical first, then high/medium/low, then by due_date asc nulls last
      const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const { data: debts, error } = await query.order("due_date", { ascending: true, nullsFirst: false });
      if (error) return serverError(error.message);

      const sorted = [...(debts ?? [])].sort((a, b) => {
        const ar = a as Record<string,unknown>;
        const br = b as Record<string,unknown>;
        return (PRIORITY_ORDER[ar.priority as string] ?? 2) - (PRIORITY_ORDER[br.priority as string] ?? 2);
      });

      return jsonCors(req, { debts: sorted });
    }

    // ── POST ─────────────────────────────────────────────────────────────────
    if (method === "POST") {
      let body: Record<string, unknown> = {};
      try { body = await req.json(); } catch { return badRequest("Invalid JSON body"); }

      // Record payment
      if (action === "record-payment") {
        const debtId    = body.debt_id as string | undefined;
        const amount    = Number(body.amount ?? 0);
        const fee       = Number(body.fee ?? 0);
        const payDate   = (body.payment_date as string) ?? new Date().toISOString().slice(0, 10);
        const notes     = (body.notes as string | null) ?? null;
        const businessId = body.business_id as string | undefined;
        const paymentMethod = (body.payment_method as string | null) ?? null;
        const reference   = (body.reference as string | null) ?? null;
        const receiptBase64 = body.receipt_base64 as string | undefined;
        const receiptMimeType = (body.receipt_mime_type as string) ?? "image/jpeg";
        const notifyCreditor = Boolean(body.notify_creditor ?? false);

        if (!debtId)    return badRequest("debt_id is required");
        if (!businessId) return badRequest("business_id is required");
        if (amount <= 0) return badRequest("amount must be positive");
        if (fee < 0) return badRequest("fee cannot be negative");

        const ctx = await requireOwnerOrManagerCtx(req, businessId);
        if (ctx instanceof Response) return ctx;

        const lockCheck = await checkMonthNotLocked(req, ctx.businessId, payDate);
        if (lockCheck) return lockCheck;

        // Verify debt belongs to this business
        const { data: debt, error: debtErr } = await supabaseAdmin
          .from("business_debts")
          .select("id, current_balance, status, business_id, creditor_name, creditor_contact, currency_code")
          .eq("id", debtId)
          .eq("business_id", businessId)
          .maybeSingle();

        if (debtErr) return serverError(debtErr.message);
        if (!debt) return notFound("Debt not found");

        const d = debt as Record<string, unknown>;
        if (d.status === "paid_off") return badRequest("This debt is already paid off");

        // Duplicate-payment guard: the same real-world payment can otherwise be
        // recorded twice (once from /owner/expenses, once from Bookkeeping, or
        // from two near-duplicate imported bank rows). Warn instead of blocking
        // outright, since recurring debts legitimately have repeated
        // same-amount payments — the caller can pass confirm_duplicate to proceed.
        const confirmDuplicate = Boolean(body.confirm_duplicate ?? false);
        if (!confirmDuplicate) {
          const windowStart = dayOffset(payDate, -3);
          const windowEnd   = dayOffset(payDate, 3);
          const { data: dupCandidates } = await supabaseAdmin
            .from("debt_payments")
            .select("id, amount, fee, payment_date, payment_method, reference, notes, created_at")
            .eq("debt_id", debtId)
            .gte("payment_date", windowStart)
            .lte("payment_date", windowEnd);

          const dup = (dupCandidates ?? []).find((p) => Math.abs(Number(p.amount) - amount) < 0.01);
          if (dup) {
            return jsonCors(req, { duplicate_warning: true, existing_payment: dup });
          }
        }

        let receiptPath: string | null = null;
        if (receiptBase64) {
          try {
            receiptPath = await uploadDebtFile(businessId, "payments", receiptBase64, receiptMimeType);
          } catch (e) {
            return serverError(e instanceof Error ? e.message : "Failed to upload receipt");
          }
        }

        // Insert payment — DB trigger reduces current_balance (amount + fee) automatically
        const { data: newPayment, error: payErr } = await supabaseAdmin
          .from("debt_payments")
          .insert({
            debt_id: debtId,
            business_id: businessId,
            amount,
            fee,
            payment_date: payDate,
            payment_method: paymentMethod,
            reference,
            receipt_url: receiptPath,
            notes,
            created_by: ctx.userId,
          })
          .select("id, debt_id, amount, fee, payment_date, payment_method, reference, receipt_url, notes, created_at")
          .single();

        if (payErr) return serverError(payErr.message);

        // Re-fetch the updated debt to return fresh state
        const { data: updated, error: refetchErr } = await supabaseAdmin
          .from("business_debts")
          .select("*")
          .eq("id", debtId)
          .single();

        if (refetchErr) return serverError(refetchErr.message);

        const creditorContact = d.creditor_contact as string | null;
        if (notifyCreditor && creditorContact?.includes("@")) {
          const { data: business } = await supabaseAdmin.from("businesses").select("name").eq("id", businessId).maybeSingle();
          await sendEmailInternal(creditorContact, "creditor_payment_notification", {
            salonName: (business as Record<string, unknown> | null)?.name as string ?? "",
            creditorName: d.creditor_name as string,
            amount: `${d.currency_code} ${amount.toFixed(2)}`,
            date: payDate,
            reference: reference ?? "",
          });
        }

        return jsonCors(req, { debt: updated, payment: newPayment });
      }

      // Add a document or note
      if (action === "document") {
        const businessId = body.business_id as string | undefined;
        const debtId     = body.debt_id as string | undefined;
        const kind       = body.kind as string | undefined;

        if (!businessId) return badRequest("business_id is required");
        if (!debtId)     return badRequest("debt_id is required");
        if (kind !== "document" && kind !== "note") return badRequest("kind must be 'document' or 'note'");

        const ctx = await requireOwnerOrManagerCtx(req, businessId);
        if (ctx instanceof Response) return ctx;

        const { data: debt } = await supabaseAdmin
          .from("business_debts")
          .select("id")
          .eq("id", debtId)
          .eq("business_id", businessId)
          .maybeSingle();
        if (!debt) return notFound("Debt not found");

        let filePath: string | null = null;
        if (kind === "document") {
          const fileBase64 = body.file_base64 as string | undefined;
          if (!fileBase64) return badRequest("file_base64 is required for a document");
          const mimeType = (body.mime_type as string) ?? "application/octet-stream";
          try {
            filePath = await uploadDebtFile(businessId, "documents", fileBase64, mimeType);
          } catch (e) {
            return serverError(e instanceof Error ? e.message : "Failed to upload file");
          }
        }

        const { data: created, error } = await supabaseAdmin
          .from("debt_documents")
          .insert({
            business_id: businessId,
            debt_id: debtId,
            kind,
            body: (body.body as string | null) ?? null,
            file_path: filePath,
            file_size: body.file_size != null ? Number(body.file_size) : null,
            mime_type: (body.mime_type as string | null) ?? null,
            created_by: ctx.userId,
          })
          .select("*, author:users!debt_documents_created_by_fkey(id, first_name, last_name)")
          .single();

        if (error) return serverError(error.message);
        return jsonCors(req, created, 201);
      }

      // Create debt
      const businessId = body.business_id as string | undefined;
      if (!businessId) return badRequest("business_id is required");

      const ctx = await requireOwnerOrManagerCtx(req, businessId);
      if (ctx instanceof Response) return ctx;

      const category       = String(body.category ?? "other");
      const originalAmount = Number(body.original_amount ?? 0);
      const currentBalance = body.current_balance !== undefined ? Number(body.current_balance) : originalAmount;
      const creditorType   = String(body.creditor_type ?? "business");
      const supplierId     = (body.supplier_id as string | null) ?? null;

      if (!VALID_CATEGORIES.includes(category))  return badRequest("Invalid category");
      if (!VALID_CREDITOR_TYPES.includes(creditorType)) return badRequest("Invalid creditor_type");
      if (originalAmount <= 0)                   return badRequest("original_amount must be positive");
      if (currentBalance < 0)                    return badRequest("current_balance cannot be negative");

      const priority = String(body.priority ?? "medium");
      if (!VALID_PRIORITIES.includes(priority))  return badRequest("Invalid priority");

      let creditorName = String(body.creditor_name ?? "").trim();
      let creditorContact = (body.creditor_contact as string | null) ?? null;

      // Linking an existing supplier auto-fills the creditor fields when the
      // caller didn't already provide them explicitly.
      if (supplierId) {
        const { data: supplier } = await supabaseAdmin
          .from("suppliers")
          .select("name, email, phone")
          .eq("id", supplierId)
          .eq("business_id", businessId)
          .maybeSingle();
        if (supplier) {
          const s = supplier as Record<string, unknown>;
          if (!creditorName) creditorName = s.name as string;
          if (!creditorContact) creditorContact = (s.email as string | null) ?? (s.phone as string | null) ?? null;
        }
      }

      if (!creditorName) return badRequest("creditor_name is required");

      const { data: created, error: createErr } = await supabaseAdmin
        .from("business_debts")
        .insert({
          business_id:              businessId,
          name:                     (body.name as string | null) ?? null,
          creditor_type:            creditorType,
          supplier_id:              supplierId,
          creditor_name:            creditorName,
          category,
          description:              (body.description as string | null) ?? null,
          reference:                (body.reference as string | null) ?? null,
          original_amount:          originalAmount,
          current_balance:          currentBalance,
          currency_code:            (body.currency_code as string) ?? "EUR",
          interest_rate:            body.interest_rate != null ? Number(body.interest_rate) : null,
          monthly_minimum:          body.monthly_minimum != null ? Number(body.monthly_minimum) : null,
          preferred_payment_method: (body.preferred_payment_method as string | null) ?? null,
          reminder_days_before:     body.reminder_days_before != null ? Number(body.reminder_days_before) : null,
          due_date:                 (body.due_date as string | null) ?? null,
          start_date:               (body.start_date as string) ?? new Date().toISOString().slice(0, 10),
          status:                   body.status === "disputed" ? "disputed" : "active",
          priority,
          creditor_contact:         creditorContact,
          notes:                    (body.notes as string | null) ?? null,
          is_interest_deductible:   Boolean(body.is_interest_deductible ?? false),
        })
        .select(`*, ${SUPPLIER_SELECT}`)
        .single();

      if (createErr) return serverError(createErr.message);
      return jsonCors(req, created, 201);
    }

    // ── PATCH ─────────────────────────────────────────────────────────────────
    if (method === "PATCH") {
      if (!id) return badRequest("id query param is required");

      let body: Record<string, unknown> = {};
      try { body = await req.json(); } catch { return badRequest("Invalid JSON body"); }

      // Resolve business_id from the debt row for auth check
      const { data: existing, error: existErr } = await supabaseAdmin
        .from("business_debts")
        .select("business_id, original_amount")
        .eq("id", id)
        .maybeSingle();

      if (existErr) return serverError(existErr.message);
      if (!existing) return notFound("Debt not found");

      const ex = existing as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, ex.business_id as string);
      if (ctx instanceof Response) return ctx;

      const update: Record<string, unknown> = {};

      if (body.name !== undefined)                  update.name = body.name ?? null;
      if (body.creditor_type !== undefined && VALID_CREDITOR_TYPES.includes(body.creditor_type as string)) update.creditor_type = body.creditor_type;
      if (body.supplier_id !== undefined)           update.supplier_id = body.supplier_id ?? null;
      if (body.creditor_name !== undefined)         update.creditor_name = String(body.creditor_name).trim();
      if (body.category !== undefined)              update.category = body.category;
      if (body.description !== undefined)           update.description = body.description ?? null;
      if (body.reference !== undefined)             update.reference = body.reference ?? null;
      if (body.original_amount !== undefined)       update.original_amount = Number(body.original_amount);
      if (body.current_balance !== undefined) {
        const newBal = Number(body.current_balance);
        update.current_balance = Math.max(0, newBal);
        if (newBal <= 0) update.status = "paid_off";
      }
      if (body.currency_code !== undefined)         update.currency_code = body.currency_code;
      if (body.interest_rate !== undefined)         update.interest_rate = body.interest_rate != null ? Number(body.interest_rate) : null;
      if (body.monthly_minimum !== undefined)       update.monthly_minimum = body.monthly_minimum != null ? Number(body.monthly_minimum) : null;
      if (body.preferred_payment_method !== undefined) update.preferred_payment_method = body.preferred_payment_method ?? null;
      if (body.reminder_days_before !== undefined)  update.reminder_days_before = body.reminder_days_before != null ? Number(body.reminder_days_before) : null;
      if (body.due_date !== undefined)              update.due_date = body.due_date ?? null;
      if (body.start_date !== undefined)            update.start_date = body.start_date;
      if (body.status !== undefined && VALID_STATUSES.includes(body.status as string)) update.status = body.status;
      if (body.priority !== undefined && VALID_PRIORITIES.includes(body.priority as string)) update.priority = body.priority;
      if (body.creditor_contact !== undefined)      update.creditor_contact = body.creditor_contact ?? null;
      if (body.notes !== undefined)                 update.notes = body.notes ?? null;
      if (body.is_interest_deductible !== undefined) update.is_interest_deductible = Boolean(body.is_interest_deductible);
      if (body.is_archived !== undefined)           update.is_archived = Boolean(body.is_archived);

      if (Object.keys(update).length === 0) return badRequest("No valid fields to update");

      const { data: updated, error: upErr } = await supabaseAdmin
        .from("business_debts")
        .update(update)
        .eq("id", id)
        .select(`*, ${SUPPLIER_SELECT}`)
        .single();

      if (upErr) return serverError(upErr.message);
      return jsonCors(req, updated);
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    if (method === "DELETE") {
      if (action === "document") {
        if (!id) return badRequest("id is required");

        const { data: doc } = await supabaseAdmin
          .from("debt_documents")
          .select("business_id, file_path")
          .eq("id", id)
          .maybeSingle();
        if (!doc) return notFound("Document not found");

        const d = doc as Record<string, unknown>;
        const ctx = await requireOwnerOrManagerCtx(req, d.business_id as string);
        if (ctx instanceof Response) return ctx;

        if (d.file_path) {
          await supabaseAdmin.storage.from("debt-documents").remove([d.file_path as string]);
        }

        const { error } = await supabaseAdmin.from("debt_documents").delete().eq("id", id);
        if (error) return serverError(error.message);
        return jsonCors(req, { success: true });
      }

      if (!id) return badRequest("id query param is required");

      const { data: existing, error: existErr } = await supabaseAdmin
        .from("business_debts")
        .select("business_id")
        .eq("id", id)
        .maybeSingle();

      if (existErr) return serverError(existErr.message);
      if (!existing) return notFound("Debt not found");

      const ex = existing as Record<string, unknown>;
      const ctx = await requireOwnerOrManagerCtx(req, ex.business_id as string);
      if (ctx instanceof Response) return ctx;

      const { error: delErr } = await supabaseAdmin
        .from("business_debts")
        .delete()
        .eq("id", id);

      if (delErr) return serverError(delErr.message);
      return jsonCors(req, { success: true });
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeadersFor(req) });

  } catch (err) {
    console.error("[debts]", err);
    return serverError(err instanceof Error ? err.message : "Unexpected error");
  }
}));
