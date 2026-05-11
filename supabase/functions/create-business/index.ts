import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, conflict, serverError } from "../_shared/errors.ts";
import { verifyAuth } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CreateBusinessBody {
  business_name: string;
}

// ---------------------------------------------------------------------------
// Slug helpers (same as auth-register)
// ---------------------------------------------------------------------------

function makeSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function findUniqueSlug(name: string, userId: string): Promise<string> {
  const base = makeSlug(name) || `business-${userId.slice(0, 8)}`;
  for (const suffix of ["", "-2", "-3", "-4", "-5"]) {
    const slug = base + suffix;
    const { data } = await supabaseAdmin
      .from("businesses")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!data) return slug;
  }
  // Guaranteed-unique fallback
  return `${base}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * POST /create-business
 * Body: { business_name: string }
 * Authorization: Bearer <user_jwt>
 *
 * Creates a new business owned by the authenticated user, adds them as owner
 * member, and creates default business_settings.
 *
 * Returns: { business_id, business_name, slug }
 */
Deno.serve(withLogging("create-business", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  try {
    // ── Auth ─────────────────────────────────────────────────────────────────
    let user: Awaited<ReturnType<typeof verifyAuth>>;
    try {
      user = await verifyAuth(req);
    } catch (e) {
      if (e instanceof Response) return e;
      throw e;
    }

    // ── Validate body ────────────────────────────────────────────────────────
    const body: CreateBusinessBody = await req.json();
    const businessName = body.business_name?.trim();
    if (!businessName) return badRequest("business_name is required");
    if (businessName.length < 2) {
      return badRequest("business_name must be at least 2 characters");
    }
    if (businessName.length > 100) {
      return badRequest("business_name must be 100 characters or fewer");
    }

    // ── Fetch caller's profile (need email for setup_new_business) ───────────
    const { data: userRow, error: userErr } = await supabaseAdmin
      .from("users")
      .select("email, first_name, last_name, phone")
      .eq("id", user.id)
      .single();

    if (userErr || !userRow) {
      return serverError("Could not fetch user profile");
    }

    // ── Generate unique slug ─────────────────────────────────────────────────
    const slug = await findUniqueSlug(businessName, user.id);

    // ── Enforce limit: max 5 businesses per owner ────────────────────────────
    const { count, error: countErr } = await supabaseAdmin
      .from("business_members")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("role", "owner")
      .eq("is_active", true);

    if (countErr) return serverError("Could not check existing businesses");
    if ((count ?? 0) >= 5) {
      return conflict("LIMIT_REACHED", "You can own a maximum of 5 businesses");
    }

    // ── Create business via existing RPC ─────────────────────────────────────
    const { data: businessId, error: rpcErr } = await supabaseAdmin.rpc(
      "setup_new_business",
      {
        p_user_id: user.id,
        p_first_name: userRow.first_name ?? "",
        p_last_name: userRow.last_name ?? null,
        p_email: userRow.email,
        p_phone: userRow.phone ?? null,
        p_business_name: businessName,
        p_business_slug: slug,
      },
    );

    if (rpcErr) {
      console.error("setup_new_business RPC error:", rpcErr);
      return serverError("Failed to create business. Please try again.");
    }

    return new Response(
      JSON.stringify({
        business_id: businessId,
        business_name: businessName,
        slug,
      }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("create-business error:", err);
    return serverError("Unexpected error");
  }
}));
