import Stripe from "stripe";
import { stripe } from "../_shared/stripe.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError, unauthorized, forbidden } from "../_shared/errors.ts";
import { withLogging } from "../_shared/logger.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * POST /stripe-connect
 *
 * Stripe Connect account management endpoint.
 * Actions:
 *   - create-account: Create a new Stripe Express account
 *   - get-onboarding-link: Get onboarding link for incomplete account
 *   - get-dashboard-link: Get login link to dashboard
 *   - get-status: Get account connection status
 *   - get-balance: Get account balance
 *   - disconnect: Disconnect the account
 */
Deno.serve(
  withLogging("stripe-connect", async (req: Request) => {
    const corsResp = handleCors(req);
    if (corsResp) return corsResp;

    if (req.method !== "POST") {
      return json({ error: { code: "METHOD_NOT_ALLOWED", message: "Only POST is allowed" } }, 405);
    }

    try {
      const body = (await req.json()) as {
        action: string;
        business_id?: string;
        return_url?: string;
        refresh_url?: string;
      };

      if (!body.action) {
        return badRequest("action is required");
      }

      if (!body.business_id) {
        return badRequest("business_id is required");
      }

      // Verify user is owner/manager of this business
      const ctx = await requireOwnerOrManagerCtx(req, body.business_id);
      if (ctx instanceof Response) return ctx;

      const businessId = ctx.businessId;
      const userId = ctx.userId;

      // ── Get or create Stripe Account record ─────────────────────────────

      const { data: existingAccount, error: fetchErr } = await supabaseAdmin
        .from("stripe_accounts")
        .select("id, account_id, connected")
        .eq("business_id", businessId)
        .maybeSingle();

      if (fetchErr) {
        console.error("stripe-connect: database fetch error:", fetchErr);
        return serverError("Failed to fetch Stripe account data");
      }

      // ── Handle each action ─────────────────────────────────────────────

      switch (body.action) {
        case "create-account":
          return handleCreateAccount(businessId, existingAccount, body);

        case "get-onboarding-link":
          if (!existingAccount?.account_id) {
            return badRequest("No Stripe account found for this business");
          }
          return handleGetOnboardingLink(existingAccount.account_id as string, body);

        case "get-dashboard-link":
          if (!existingAccount?.account_id) {
            return badRequest("No Stripe account found for this business");
          }
          return handleGetDashboardLink(existingAccount.account_id as string);

        case "get-status":
          if (!existingAccount?.account_id) {
            // No account yet, return disconnected status
            return json({
              connected: false,
              account_id: null,
              charges_enabled: false,
              payouts_enabled: false,
              details_submitted: false,
            });
          }
          return handleGetStatus(existingAccount.account_id as string, businessId);

        case "get-balance":
          if (!existingAccount?.account_id) {
            return badRequest("No Stripe account found for this business");
          }
          return handleGetBalance(existingAccount.account_id as string);

        case "disconnect":
          if (!existingAccount?.account_id) {
            return badRequest("No Stripe account found for this business");
          }
          return handleDisconnect(businessId, existingAccount.id as string);

        default:
          return badRequest(`Unknown action: ${body.action}`);
      }
    } catch (err) {
      if (err instanceof Response) return err;
      console.error("stripe-connect error:", err);
      return serverError("An unexpected error occurred");
    }
  }),
);

// ────────────────────────────────────────────────────────────────────────────
// Action handlers
// ────────────────────────────────────────────────────────────────────────────

async function handleCreateAccount(
  businessId: string,
  existingAccount: { id: string; account_id: string | null; connected: boolean } | null,
  body: {
    return_url?: string;
    refresh_url?: string;
  },
): Promise<Response> {
  try {
    // If account already exists, just return its onboarding link
    if (existingAccount?.account_id) {
      const onboardingLink = await stripe.accounts.createLoginLink(existingAccount.account_id);
      if (!onboardingLink) {
        return serverError("Failed to create onboarding link");
      }
    }

    // Create a new Stripe Express account
    const account = await stripe.accounts.create({
      type: "express",
      country: "EE", // Default to Estonia for Afrotouch, can be made dynamic later
      email: "", // Empty, user will provide during onboarding
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true },
      },
      settings: {
        payouts: {
          statement_descriptor: "KaziOne Booking",
        },
      },
    });

    // Store in database
    if (existingAccount) {
      // Update existing record
      const { error: updateErr } = await supabaseAdmin
        .from("stripe_accounts")
        .update({ account_id: account.id, connected: false })
        .eq("id", existingAccount.id);

      if (updateErr) {
        console.error("stripe-connect: database update error:", updateErr);
        return serverError("Failed to save account ID");
      }
    } else {
      // Create new record
      const { error: insertErr } = await supabaseAdmin
        .from("stripe_accounts")
        .insert({
          business_id: businessId,
          account_id: account.id,
          connected: false,
        });

      if (insertErr) {
        console.error("stripe-connect: database insert error:", insertErr);
        return serverError("Failed to save account ID");
      }
    }

    // Get onboarding link
    const onboardingLink = await stripe.accountLinks.create({
      account: account.id,
      type: "account_onboarding",
      return_url: body.return_url || "https://kazionebooking.com",
      refresh_url: body.refresh_url || "https://kazionebooking.com",
    });

    return json({
      account_id: account.id,
      onboarding_url: onboardingLink.url,
    });
  } catch (err) {
    console.error("stripe-connect: create account error:", err);
    return serverError("Failed to create Stripe account");
  }
}

async function handleGetOnboardingLink(
  accountId: string,
  body: {
    return_url?: string;
    refresh_url?: string;
  },
): Promise<Response> {
  try {
    const onboardingLink = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      return_url: body.return_url || "https://kazionebooking.com",
      refresh_url: body.refresh_url || "https://kazionebooking.com",
    });

    return json({
      onboarding_url: onboardingLink.url,
    });
  } catch (err) {
    console.error("stripe-connect: get onboarding link error:", err);
    return serverError("Failed to get onboarding link");
  }
}

async function handleGetDashboardLink(accountId: string): Promise<Response> {
  try {
    const loginLink = await stripe.accounts.createLoginLink(accountId);

    return json({
      dashboard_url: loginLink.url,
    });
  } catch (err) {
    console.error("stripe-connect: get dashboard link error:", err);
    return serverError("Failed to get dashboard link");
  }
}

async function handleGetStatus(
  accountId: string,
  businessId: string,
): Promise<Response> {
  try {
    const account = await stripe.accounts.retrieve(accountId);

    // Update connected status in database
    const { error: updateErr } = await supabaseAdmin
      .from("stripe_accounts")
      .update({
        connected: account.charges_enabled && account.payouts_enabled,
        data: account,
      })
      .eq("account_id", accountId);

    if (updateErr) {
      console.error("stripe-connect: failed to update account status:", updateErr);
      // Don't fail the request, just log it
    }

    return json({
      connected: account.charges_enabled && account.payouts_enabled,
      account_id: accountId,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      details_submitted: account.details_submitted,
      requirements: account.requirements,
    });
  } catch (err) {
    console.error("stripe-connect: get status error:", err);
    return serverError("Failed to get account status");
  }
}

async function handleGetBalance(accountId: string): Promise<Response> {
  try {
    const balance = await stripe.balance.retrieve({ stripeAccount: accountId });

    return json({
      available: balance.available,
      pending: balance.pending,
    });
  } catch (err) {
    console.error("stripe-connect: get balance error:", err);
    return serverError("Failed to get account balance");
  }
}

async function handleDisconnect(
  businessId: string,
  accountRecordId: string,
): Promise<Response> {
  try {
    // Delete the account record from our database
    const { error: deleteErr } = await supabaseAdmin
      .from("stripe_accounts")
      .delete()
      .eq("id", accountRecordId);

    if (deleteErr) {
      console.error("stripe-connect: delete account record error:", deleteErr);
      return serverError("Failed to disconnect account");
    }

    return json({
      connected: false,
    });
  } catch (err) {
    console.error("stripe-connect: disconnect error:", err);
    return serverError("Failed to disconnect account");
  }
}
