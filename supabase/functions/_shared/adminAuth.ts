import { supabaseAdmin } from "./supabaseAdmin.ts";
import { adminErrors } from "./adminCors.ts";

export interface AdminContext {
  adminId: string;
  adminEmail: string;
}

/**
 * Verifies the request comes from a KaziOne platform admin.
 *
 * Must be the FIRST call in every admin edge function — no exceptions.
 * Returns AdminContext on success or a Response (401/403) on failure.
 *
 * Usage:
 *   const ctx = await requirePlatformAdmin(req);
 *   if (ctx instanceof Response) return ctx;
 *   // ctx.adminId is now safe to use for audit logging
 */
export async function requirePlatformAdmin(
  req: Request,
): Promise<AdminContext | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return adminErrors.unauthorized("Missing or invalid Authorization header");
  }

  const token = authHeader.replace("Bearer ", "");

  // Verify JWT with Supabase Auth
  const {
    data: { user },
    error: authError,
  } = await supabaseAdmin.auth.getUser(token);

  if (authError || !user) {
    return adminErrors.unauthorized("Invalid or expired token");
  }

  // Check is_platform_admin flag — service role bypasses RLS so this is authoritative
  const { data: profile, error: profileError } = await supabaseAdmin
    .from("users")
    .select("is_platform_admin")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) {
    console.error("[adminAuth] Profile lookup error:", profileError.message);
    return adminErrors.unauthorized("Could not verify admin status");
  }

  if (!profile?.is_platform_admin) {
    return adminErrors.forbidden("Platform admin access required");
  }

  return {
    adminId: user.id,
    adminEmail: user.email ?? "",
  };
}

/**
 * Extract the caller's IP address from Cloudflare-forwarded headers.
 * Used to populate ip_address in admin_audit_log.
 */
export function getCallerIp(req: Request): string | undefined {
  return (
    req.headers.get("CF-Connecting-IP") ??
    req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    undefined
  );
}
