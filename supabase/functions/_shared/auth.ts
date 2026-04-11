import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { supabaseAdmin } from "./supabaseAdmin.ts";
import { unauthorized, forbidden } from "./errors.ts";

/**
 * Extract + verify the Bearer JWT from the request.
 * Returns the authenticated Supabase user or throws an unauthorized Response.
 */
export async function verifyAuth(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw unauthorized("Missing or invalid Authorization header");
  }

  const token = authHeader.replace("Bearer ", "");

  // Create a per-request client scoped to this user's JWT
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    throw unauthorized("Invalid or expired token");
  }

  return user;
}

/**
 * Verify the user is an active member of the given business.
 * Returns { role, memberId } or throws forbidden().
 */
export async function verifyBusinessMember(
  userId: string,
  businessId: string,
): Promise<{ role: string; memberId: string }> {
  const { data, error } = await supabaseAdmin
    .from("business_members")
    .select("id, role")
    .eq("business_id", businessId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .single();

  if (error || !data) {
    throw forbidden("You are not a member of this business");
  }

  return { role: data.role as string, memberId: data.id as string };
}

/**
 * Throws 403 if the user is not an owner or manager of the business.
 */
export async function requireOwnerOrManager(
  userId: string,
  businessId: string,
): Promise<{ role: string; memberId: string }> {
  const member = await verifyBusinessMember(userId, businessId);

  if (member.role !== "owner" && member.role !== "manager") {
    throw forbidden("Owner or manager role required");
  }

  return member;
}

// ── Verified auth context ────────────────────────────────────────────────────

export type AuthContext = {
  userId: string;
  /** business_id verified via DB membership check — safe to use for queries */
  businessId: string;
  role: string;
};

/**
 * Single-call auth helper for protected owner/manager endpoints.
 *
 * Validates the Bearer JWT, then confirms the user is an active owner or
 * manager of the requested business. Returns a typed AuthContext where
 * businessId is authoritative (proven by DB, not blindly trusted from the
 * request body).
 *
 * Usage:
 *   const body = await req.json()
 *   const ctx = await requireOwnerOrManagerCtx(req, body.business_id)
 *   if (ctx instanceof Response) return ctx
 *   // ctx.businessId is now safe to use
 */
export async function requireOwnerOrManagerCtx(
  req: Request,
  businessId: string | undefined,
): Promise<AuthContext | Response> {
  if (!businessId) {
    return forbidden("business_id is required");
  }
  try {
    const user = await verifyAuth(req);
    const { role } = await requireOwnerOrManager(user.id, businessId);
    return { userId: user.id, businessId, role };
  } catch (e) {
    if (e instanceof Response) return e;
    console.error("requireOwnerOrManagerCtx error:", e);
    return new Response(
      JSON.stringify({
        error: { code: "INTERNAL_ERROR", message: "Auth check failed" },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Find an existing client by email within a business, or create a new guest
 * client record. Returns the client row.
 */
export async function getOrCreateGuestClient(
  businessId: string,
  email: string,
  firstName: string,
  lastName: string,
  phone?: string,
) {
  // Try to find existing client by email
  const { data: existing } = await supabaseAdmin
    .from("clients")
    .select("*")
    .eq("business_id", businessId)
    .eq("email", email)
    .maybeSingle();

  if (existing) return existing;

  // Create new guest client
  const { data: created, error } = await supabaseAdmin
    .from("clients")
    .insert({
      business_id: businessId,
      first_name: firstName,
      last_name: lastName,
      email,
      phone: phone ?? null,
      source: "marketplace",
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create guest client: ${error.message}`);
  }

  return created;
}
