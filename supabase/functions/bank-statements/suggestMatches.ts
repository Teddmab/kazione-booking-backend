import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { amountScore, dateScore } from "../_shared/matchScoring.ts";

export interface ReverseMatchCandidate {
  type: "payment" | "expense" | "fixed_cost" | "debt_payment";
  id: string;
  score: number; // 0-100
  data: Record<string, unknown>;
}

export interface UsedRecordIds {
  payments: Set<string>;
  expenses: Set<string>;
  fixedCosts: Set<string>;
  debtPayments: Set<string>;
}

function dayOffset(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** IDs already consumed by some other bank_transactions row — computed once
 *  per bulk call, not per transaction, to keep the endpoint bounded. */
export async function loadUsedRecordIds(businessId: string): Promise<UsedRecordIds> {
  const [p, e, fc, dp] = await Promise.all([
    supabaseAdmin.from("bank_transactions").select("reconciled_payment_id").eq("business_id", businessId).not("reconciled_payment_id", "is", null),
    supabaseAdmin.from("bank_transactions").select("reconciled_expense_id").eq("business_id", businessId).not("reconciled_expense_id", "is", null),
    supabaseAdmin.from("bank_transactions").select("reconciled_fixed_cost_id").eq("business_id", businessId).not("reconciled_fixed_cost_id", "is", null),
    supabaseAdmin.from("bank_transactions").select("reconciled_debt_payment_id").eq("business_id", businessId).not("reconciled_debt_payment_id", "is", null),
  ]);
  return {
    payments: new Set((p.data ?? []).map((r) => r.reconciled_payment_id as string)),
    expenses: new Set((e.data ?? []).map((r) => r.reconciled_expense_id as string)),
    fixedCosts: new Set((fc.data ?? []).map((r) => r.reconciled_fixed_cost_id as string)),
    debtPayments: new Set((dp.data ?? []).map((r) => r.reconciled_debt_payment_id as string)),
  };
}

/** Given ONE unreconciled bank_transaction's own {amount, date, description}
 *  as the seed, find candidate payments/expenses/fixed_costs/debt_payments.
 *  Appointments are deliberately skipped — paid appointments already
 *  surface via `payments`, and unpaid walk-ins have no financial record to
 *  match to. */
export async function findRecordCandidates(
  businessId: string,
  tx: { amount: number; date: string; description: string },
  exclude: UsedRecordIds,
): Promise<ReverseMatchCandidate[]> {
  const dateMs = new Date(tx.date + "T12:00:00Z").getTime();
  const dateFrom = dayOffset(tx.date, -2);
  const dateTo = dayOffset(tx.date, 2);
  const absAmount = Math.abs(tx.amount);
  const amountLow = absAmount * 0.95;
  const amountHigh = absAmount * 1.05;
  const candidates: ReverseMatchCandidate[] = [];

  if (tx.amount > 0) {
    const { data: payments } = await supabaseAdmin
      .from("payments")
      .select("id, amount, paid_at, method, appointment_id")
      .eq("business_id", businessId)
      .eq("status", "paid")
      .gte("paid_at", dateFrom + "T00:00:00.000Z")
      .lte("paid_at", dateTo + "T23:59:59.999Z")
      .gte("amount", amountLow)
      .lte("amount", amountHigh)
      .limit(10);
    for (const p of (payments ?? []) as Record<string, unknown>[]) {
      if (exclude.payments.has(p.id as string)) continue;
      const amt = Number(p.amount);
      const score = Math.round((
        amountScore(amt, absAmount) * 0.6 +
        dateScore(new Date(p.paid_at as string).getTime(), dateMs, 2) * 0.4
      ) * 100);
      candidates.push({ type: "payment", id: p.id as string, score, data: p });
    }
  } else if (tx.amount < 0) {
    // Amount 0.7 / date 0.3 — no merchant-substring term here (unlike
    // receipt-scan's OCR-driven scorer): expenses/fixed_costs/debt_payments
    // have no reliable free-text field to compare a bank description
    // against, so fabricating a substring heuristic wouldn't be grounded.
    const [expensesRes, fixedCostsRes, debtPaymentsRes] = await Promise.all([
      supabaseAdmin.from("expenses").select("id, amount, date, description, category")
        .eq("business_id", businessId).gte("date", dateFrom).lte("date", dateTo)
        .gte("amount", amountLow).lte("amount", amountHigh).limit(10),
      supabaseAdmin.from("fixed_costs").select("id, amount, cost_date, name, category")
        .eq("business_id", businessId).gte("cost_date", dateFrom).lte("cost_date", dateTo)
        .gte("amount", amountLow).lte("amount", amountHigh).limit(10),
      supabaseAdmin.from("debt_payments").select("id, amount, payment_date, notes, debt:business_debts(creditor_name)")
        .eq("business_id", businessId).gte("payment_date", dateFrom).lte("payment_date", dateTo)
        .gte("amount", amountLow).lte("amount", amountHigh).limit(10),
    ]);

    for (const e of (expensesRes.data ?? []) as Record<string, unknown>[]) {
      if (exclude.expenses.has(e.id as string)) continue;
      const score = Math.round((
        amountScore(Number(e.amount), absAmount) * 0.7 +
        dateScore(new Date(e.date as string + "T12:00:00Z").getTime(), dateMs, 2) * 0.3
      ) * 100);
      candidates.push({ type: "expense", id: e.id as string, score, data: e });
    }
    for (const fc of (fixedCostsRes.data ?? []) as Record<string, unknown>[]) {
      if (exclude.fixedCosts.has(fc.id as string)) continue;
      const score = Math.round((
        amountScore(Number(fc.amount), absAmount) * 0.7 +
        dateScore(new Date(fc.cost_date as string + "T12:00:00Z").getTime(), dateMs, 2) * 0.3
      ) * 100);
      candidates.push({ type: "fixed_cost", id: fc.id as string, score, data: fc });
    }
    for (const dp of (debtPaymentsRes.data ?? []) as Record<string, unknown>[]) {
      if (exclude.debtPayments.has(dp.id as string)) continue;
      const score = Math.round((
        amountScore(Number(dp.amount), absAmount) * 0.7 +
        dateScore(new Date(dp.payment_date as string + "T12:00:00Z").getTime(), dateMs, 2) * 0.3
      ) * 100);
      candidates.push({ type: "debt_payment", id: dp.id as string, score, data: dp });
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, 3);
}
