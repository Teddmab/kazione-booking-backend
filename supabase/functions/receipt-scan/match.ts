import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

export interface OcrData {
  amount: number | null;
  currency: string | null;
  date: string | null;           // YYYY-MM-DD
  merchant_name: string | null;
  tax_amount: number | null;
  line_items: { description: string; amount: number }[];
}

export interface MatchCandidate {
  type: "appointment" | "expense" | "bank_transaction";
  id: string;
  score: number;               // 0–100
  data: Record<string, unknown>;
}

export async function findCandidates(
  businessId: string,
  ocr: OcrData,
  receiptType: "income" | "expense" = "income",
): Promise<MatchCandidate[]> {
  if (!ocr.date || !ocr.amount) return [];

  const candidates: MatchCandidate[] = [];

  const baseDate = new Date(ocr.date + "T12:00:00Z");
  const dateFrom = new Date(baseDate);
  dateFrom.setDate(dateFrom.getDate() - 2);
  const dateTo = new Date(baseDate);
  dateTo.setDate(dateTo.getDate() + 2);

  const amountLow  = ocr.amount * 0.95;
  const amountHigh = ocr.amount * 1.05;

  const dateFromStr = dateFrom.toISOString().slice(0, 10);
  const dateToStr   = dateTo.toISOString().slice(0, 10);

  if (receiptType === "income") {
    // Income receipt (from payment terminal) → match completed appointments
    const { data: appts } = await supabaseAdmin
      .from("appointments")
      .select(`
        id, booking_reference, starts_at, price, status,
        client:clients!inner(first_name, last_name),
        service:services!inner(name)
      `)
      .eq("business_id", businessId)
      .eq("status", "completed")
      .gte("starts_at", dateFrom.toISOString())
      .lte("starts_at", dateTo.toISOString())
      .gte("price", amountLow)
      .lte("price", amountHigh)
      .is("deleted_at", null)
      .limit(10);

    for (const appt of (appts ?? []) as Record<string, unknown>[]) {
      const price = appt.price as number;
      const startsAt = appt.starts_at as string;
      const amountScore = 1 - Math.abs(price - ocr.amount) / ocr.amount;
      const daysDiff = Math.abs(new Date(startsAt).getTime() - baseDate.getTime()) / 86_400_000;
      const dateScore = Math.max(0, 1 - daysDiff / 2);
      const score = Math.round((amountScore * 0.6 + dateScore * 0.4) * 100);
      candidates.push({ type: "appointment", id: appt.id as string, score, data: appt });
    }

    // Also match bank credit transactions (income deposited to the business account)
    const { data: bankCredits } = await supabaseAdmin
      .from("bank_transactions")
      .select("id, date, description, amount, currency_code, reference")
      .eq("business_id", businessId)
      .gt("amount", 0)
      .gte("date", dateFromStr)
      .lte("date", dateToStr)
      .gte("amount", amountLow)
      .lte("amount", amountHigh)
      .is("reconciled_payment_id", null)
      .is("reconciled_appointment_id", null)
      .limit(5);

    for (const tx of (bankCredits ?? []) as Record<string, unknown>[]) {
      const txAmount      = tx.amount as number;
      const txDate        = tx.date as string;
      const txDesc        = (tx.description as string ?? "").toLowerCase();
      const amountScore   = 1 - Math.abs(txAmount - ocr.amount!) / ocr.amount!;
      const daysDiff      = Math.abs(new Date(txDate).getTime() - baseDate.getTime()) / 86_400_000;
      const dateScore     = Math.max(0, 1 - daysDiff / 2);
      const merchantScore = ocr.merchant_name && txDesc.includes(ocr.merchant_name.toLowerCase()) ? 1 : 0;
      const score = Math.round((amountScore * 0.5 + dateScore * 0.3 + merchantScore * 0.2) * 100);
      candidates.push({ type: "bank_transaction", id: tx.id as string, score, data: tx });
    }
  } else {
    // Expense receipt → match existing expense records (duplicate detection)
    const { data: expenses } = await supabaseAdmin
      .from("expenses")
      .select("id, description, amount, date, category, supplier_id")
      .eq("business_id", businessId)
      .gte("date", dateFromStr)
      .lte("date", dateToStr)
      .gte("amount", amountLow)
      .lte("amount", amountHigh)
      .limit(10);

    for (const exp of (expenses ?? []) as Record<string, unknown>[]) {
      const amount = exp.amount as number;
      const amountScore = 1 - Math.abs(amount - ocr.amount!) / ocr.amount!;
      const score = Math.round(Math.min(80, amountScore * 80));
      candidates.push({ type: "expense", id: exp.id as string, score, data: exp });
    }

    // Also match bank debit transactions (money leaving the business for this purchase)
    const { data: bankDebits } = await supabaseAdmin
      .from("bank_transactions")
      .select("id, date, description, amount, currency_code, reference")
      .eq("business_id", businessId)
      .lt("amount", 0)           // debits are stored as negative values
      .gte("date", dateFromStr)
      .lte("date", dateToStr)
      .gte("amount", -amountHigh) // e.g. amount >= -52.50
      .lte("amount", -amountLow)  // e.g. amount <= -47.50
      .is("reconciled_expense_id", null)
      .limit(5);

    for (const tx of (bankDebits ?? []) as Record<string, unknown>[]) {
      const txAmount      = Math.abs(tx.amount as number);
      const txDate        = tx.date as string;
      const txDesc        = (tx.description as string ?? "").toLowerCase();
      const amountScore   = 1 - Math.abs(txAmount - ocr.amount!) / ocr.amount!;
      const daysDiff      = Math.abs(new Date(txDate).getTime() - baseDate.getTime()) / 86_400_000;
      const dateScore     = Math.max(0, 1 - daysDiff / 2);
      const merchantScore = ocr.merchant_name && txDesc.includes(ocr.merchant_name.toLowerCase()) ? 1 : 0;
      const score = Math.round((amountScore * 0.5 + dateScore * 0.3 + merchantScore * 0.2) * 100);
      // Normalise amount to positive so frontend display is consistent
      candidates.push({ type: "bank_transaction", id: tx.id as string, score, data: { ...tx, amount: txAmount } });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 6);
}
