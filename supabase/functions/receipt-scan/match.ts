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
  type: "appointment" | "expense";
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
  } else {
    // Expense receipt → match existing expense records (duplicate detection)
    const { data: expenses } = await supabaseAdmin
      .from("expenses")
      .select("id, description, amount, date, category, supplier_id")
      .eq("business_id", businessId)
      .gte("date", dateFrom.toISOString().slice(0, 10))
      .lte("date", dateTo.toISOString().slice(0, 10))
      .gte("amount", amountLow)
      .lte("amount", amountHigh)
      .limit(10);

    for (const exp of (expenses ?? []) as Record<string, unknown>[]) {
      const amount = exp.amount as number;
      const amountScore = 1 - Math.abs(amount - ocr.amount!) / ocr.amount!;
      const score = Math.round(Math.min(80, amountScore * 80));
      candidates.push({ type: "expense", id: exp.id as string, score, data: exp });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 5);
}
