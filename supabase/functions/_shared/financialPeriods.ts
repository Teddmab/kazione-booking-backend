import { supabaseAdmin } from "./supabaseAdmin.ts";
import { conflict, serverError } from "./errors.ts";

/** First-of-month YYYY-MM-01 for any YYYY-MM-DD (or longer ISO) date string. */
export function monthKeyOf(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

/**
 * Returns a 409 Response ({ code: "MONTH_LOCKED" }) if dateStr's calendar
 * month is closed for this business, or null if the write may proceed.
 *
 * Call immediately after ctx resolution in every owner-editable bookkeeping
 * write path (expenses, fixed costs, debt payments, bank transactions) —
 * NOT in public/webhook/customer-driven paths (create-booking, payment
 * webhooks, appointment payment settlement), which are operational records,
 * not bookkeeping edits.
 *
 * Usage:
 *   const lockCheck = await checkMonthNotLocked(req, ctx.businessId, body.date);
 *   if (lockCheck) return lockCheck;
 */
export async function checkMonthNotLocked(
  req: Request,
  businessId: string,
  dateStr: string,
): Promise<Response | null> {
  const periodMonth = monthKeyOf(dateStr);
  const { data, error } = await supabaseAdmin
    .from("financial_periods")
    .select("id")
    .eq("business_id", businessId)
    .eq("period_month", periodMonth)
    .eq("status", "closed")
    .maybeSingle();

  if (error) return serverError(req, error.message);
  if (data) {
    return conflict(
      req,
      "MONTH_LOCKED",
      `${periodMonth.slice(0, 7)} is closed for bookkeeping — reopen the month to edit records in it`,
    );
  }
  return null;
}
