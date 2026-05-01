import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, conflict, serverError } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisterBody {
  email: string;
  password: string;
  ownerName: string;
  phone?: string;
  businessName?: string;
  role: "business" | "customer";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Slug helpers
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
  for (const suffix of ["", "-2", "-3", "-4"]) {
    const slug = base + suffix;
    const { data } = await supabaseAdmin
      .from("businesses")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!data) return slug;
  }
  // Final fallback: guaranteed unique
  return `${base}-${userId.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("auth-register", async (req: Request) => {
  const corsResp = handleCors(req);
  if (corsResp) return corsResp;

  if (req.method !== "POST") {
    return badRequest("Only POST is allowed");
  }

  try {
    const body: RegisterBody = await req.json();

    // ── Validate ────────────────────────────────────────────────────────────
    if (!body.email) return badRequest("email is required");
    if (!EMAIL_RE.test(body.email)) return badRequest("Invalid email address");
    if (!body.password || body.password.length < 8) {
      return badRequest("password must be at least 8 characters");
    }
    if (!body.ownerName?.trim()) return badRequest("ownerName is required");
    if (!body.role || !["business", "customer"].includes(body.role)) {
      return badRequest("role must be 'business' or 'customer'");
    }
    if (body.role === "business" && !body.businessName?.trim()) {
      return badRequest("businessName is required for business accounts");
    }

    const email = body.email.toLowerCase().trim();
    const nameParts = body.ownerName.trim().split(" ");
    const firstName = nameParts[0] ?? "";
    const lastName = nameParts.slice(1).join(" ") || null;

    // ── Create auth user ─────────────────────────────────────────────────────
    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password: body.password,
        email_confirm: true,
        user_metadata: { full_name: body.ownerName.trim() },
      });

    if (authError) {
      const msg = authError.message.toLowerCase();
      if (msg.includes("already registered") || msg.includes("already exists")) {
        return conflict("EMAIL_TAKEN", "An account with this email already exists");
      }
      return badRequest(authError.message);
    }

    const userId = authData.user.id;

    // ── Business registration ────────────────────────────────────────────────
    if (body.role === "business") {
      const slug = await findUniqueSlug(body.businessName!, userId);

      const { error: setupError } = await supabaseAdmin.rpc("setup_new_business", {
        p_user_id: userId,
        p_first_name: firstName,
        p_last_name: lastName,
        p_email: email,
        p_phone: body.phone ?? null,
        p_business_name: body.businessName!.trim(),
        p_business_slug: slug,
      });

      if (setupError) {
        // Rollback: delete auth user to prevent orphaned account
        await supabaseAdmin.auth.admin.deleteUser(userId);
        console.error("setup_new_business RPC failed:", setupError);
        return serverError("Account setup failed. Please try again.");
      }

      return new Response(
        JSON.stringify({ message: "Business account created successfully" }),
        {
          status: 201,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // ── Customer registration ────────────────────────────────────────────────
    // Upsert: on_auth_user_created trigger may have already inserted a bare row.
    const { error: userError } = await supabaseAdmin.from("users").upsert({
      id: userId,
      email,
      first_name: firstName,
      last_name: lastName,
      phone: body.phone ?? null,
    }, { onConflict: "id" });

    if (userError) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      console.error("Customer user insert failed:", userError);
      return serverError("Account setup failed. Please try again.");
    }

    return new Response(
      JSON.stringify({ message: "Customer account created successfully" }),
      {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("auth-register error:", err);
    return serverError("Registration failed");
  }
}));
