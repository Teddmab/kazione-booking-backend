import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FinanceInsightItem {
  type: string;
  title: string;
  description: string;
  recommendation: string;
  priority: "high" | "medium" | "low";
}

interface RequestBody {
  business_id: string;
  period_days: 7 | 14 | 30 | 90;
  question?: string;
}

const VALID_PERIODS = [7, 14, 30, 90];
const CACHE_HOURS = 6;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function periodRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return {
    from: from.toISOString().split("T")[0],
    to: to.toISOString().split("T")[0],
  };
}

function previousPeriodRange(days: number): { from: string; to: string } {
  const to = new Date();
  to.setDate(to.getDate() - days);
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return {
    from: from.toISOString().split("T")[0],
    to: to.toISOString().split("T")[0],
  };
}

// ---------------------------------------------------------------------------
// Context gathering — financial metrics only, NO PII
// ---------------------------------------------------------------------------

async function gatherFinanceContext(businessId: string, days: number) {
  const current = periodRange(days);
  const previous = previousPeriodRange(days);

  // 1. Current period revenue
  const { data: currentRevenue, error: e1 } = await supabaseAdmin.rpc(
    "get_revenue_summary",
    {
      p_business_id: businessId,
      p_start_date: current.from,
      p_end_date: current.to,
    },
  );
  if (e1) throw e1;

  // 2. Previous period revenue (for trend comparison)
  const { data: previousRevenue, error: e2 } = await supabaseAdmin.rpc(
    "get_revenue_summary",
    {
      p_business_id: businessId,
      p_start_date: previous.from,
      p_end_date: previous.to,
    },
  );
  if (e2) throw e2;

  // 3. Expense breakdown
  const { data: expenseBreakdown, error: e3 } = await supabaseAdmin.rpc(
    "get_expense_breakdown",
    {
      p_business_id: businessId,
      p_start_date: current.from,
      p_end_date: current.to,
    },
  );
  if (e3) throw e3;

  // 4. Tax summary for current year
  const currentYear = new Date().getFullYear();
  const { data: taxSummary, error: e4 } = await supabaseAdmin.rpc("get_tax_summary", {
    p_business_id: businessId,
    p_year: currentYear,
  });
  if (e4) throw e4;

  // 5. Full expense list for gap detection
  const { data: expenses, error: e5 } = await supabaseAdmin
    .from("expenses")
    .select("category, date, amount, description, receipt_url")
    .eq("business_id", businessId)
    .gte("date", current.from)
    .lte("date", current.to)
    .order("date", { ascending: false });
  if (e5) throw e5;

  // 6. Payment data for income analysis
  const { data: payments, error: e6 } = await supabaseAdmin
    .from("payments")
    .select("amount, tax_amount, method, paid_at")
    .eq("business_id", businessId)
    .eq("status", "succeeded")
    .gte("paid_at", current.from)
    .lte("paid_at", current.to);
  if (e6) throw e6;

  // Compute derived metrics
  const totalIncome = currentRevenue?.total_income ?? 0;
  const totalExpenses = currentRevenue?.total_expenses ?? 0;
  const netProfit = currentRevenue?.net_profit ?? 0;
  const prevIncome = previousRevenue?.total_income ?? 0;
  const prevExpenses = previousRevenue?.total_expenses ?? 0;

  const revenueChangePercent =
    prevIncome > 0
      ? Math.round(((totalIncome - prevIncome) / prevIncome) * 100)
      : null;
  const expenseChangePercent =
    prevExpenses > 0
      ? Math.round(((totalExpenses - prevExpenses) / prevExpenses) * 100)
      : null;
  const profitMargin =
    totalIncome > 0 ? Math.round((netProfit / totalIncome) * 100) : 0;

  // Expense gap detection
  const expenseCategories = new Set(
    (expenses ?? []).map((e: { category: string }) => e.category),
  );
  const expectedCategories = [
    "supplies",
    "rent",
    "utilities",
    "payroll",
    "marketing",
    "equipment",
    "software",
    "professional_services",
  ];
  const missingCategories = expectedCategories.filter(
    (c) => !expenseCategories.has(c),
  );

  // Receipt compliance
  const totalExpenseRows = expenses?.length ?? 0;
  const withReceipt = expenses?.filter(
    (e: { receipt_url: string | null }) => e.receipt_url,
  ).length ?? 0;
  const receiptRate =
    totalExpenseRows > 0
      ? Math.round((withReceipt / totalExpenseRows) * 100)
      : 100;

  // Tax exposure
  const totalTaxCollected =
    payments?.reduce(
      (sum: number, p: { tax_amount: number }) => sum + (p.tax_amount ?? 0),
      0,
    ) ?? 0;

  // Payment method breakdown
  const methodCounts = new Map<string, { count: number; total: number }>();
  for (const p of payments ?? []) {
    const m = (p as { method: string }).method ?? "unknown";
    const entry = methodCounts.get(m) ?? { count: 0, total: 0 };
    entry.count += 1;
    entry.total += (p as { amount: number }).amount;
    methodCounts.set(m, entry);
  }

  return {
    period: { current, previous, days },
    revenue: {
      current_income: totalIncome,
      current_expenses: totalExpenses,
      net_profit: netProfit,
      profit_margin_pct: profitMargin,
      previous_income: prevIncome,
      previous_expenses: prevExpenses,
      revenue_change_pct: revenueChangePercent,
      expense_change_pct: expenseChangePercent,
      income_by_service: currentRevenue?.income_by_service ?? [],
      income_by_payment_method: currentRevenue?.income_by_payment_method ?? [],
    },
    expenses: {
      breakdown: (expenseBreakdown ?? []).map(
        (e: { category: string; amount: number; expense_count: number }) => ({
          category: e.category,
          amount: e.amount,
          count: e.expense_count,
        }),
      ),
      total_rows: totalExpenseRows,
      receipt_compliance_pct: receiptRate,
      missing_categories: missingCategories,
    },
    tax: {
      year: currentYear,
      tax_collected: totalTaxCollected,
      annual_summary: taxSummary
        ? {
            gross_income: taxSummary.gross_income,
            tax_collected: taxSummary.tax_collected,
            total_expenses: taxSummary.total_expenses,
            net_profit: taxSummary.net_profit,
            estimated_liability: taxSummary.gross_income
              ? Math.round(taxSummary.gross_income * 0.2)
              : 0,
          }
        : null,
    },
    payment_methods: Object.fromEntries(methodCounts),
  };
}

// ---------------------------------------------------------------------------
// Anthropic call
// ---------------------------------------------------------------------------

async function callAnthropic(
  context: Record<string, unknown>,
  question?: string,
): Promise<FinanceInsightItem[]> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const userMessage = question
    ? `Here are the financial metrics:\n${JSON.stringify(context, null, 2)}\n\nQuestion: ${question}`
    : `Here are the financial metrics:\n${JSON.stringify(context, null, 2)}\n\nProvide a financial health summary with actionable recommendations.`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1200,
      system:
        "You are KaziOne AI Finance Advisor, a financial intelligence assistant for beauty and wellness businesses. " +
        "Analyze the provided financial metrics and return actionable insights as JSON only. " +
        "Focus on: financial health summary, tax preparation reminders, cost reduction opportunities, " +
        "bookkeeping gaps (missing receipts, uncategorized expenses), revenue trends, and profit margin optimization. " +
        "Be specific, practical, and data-driven. Never invent data not in the provided metrics. " +
        'Respond with a JSON object: { "insights": [{ "type": string (one of "financial_health"|"tax_prep"|"cost_reduction"|"bookkeeping_gap"|"revenue_trend"|"profit_optimization"), "title": string, "description": string, "recommendation": string, "priority": "high"|"medium"|"low" }] }. ' +
        "Do not include any text outside the JSON object.",
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";

  // Extract JSON from the response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No valid JSON in AI response");

  const parsed = JSON.parse(jsonMatch[0]);
  return (parsed.insights ?? []) as FinanceInsightItem[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("ai-finance", async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== "POST") {
      return badRequest("Method not allowed");
    }

    const body = (await req.json()) as RequestBody;
    const { business_id, period_days, question } = body;

    if (!business_id || !VALID_PERIODS.includes(period_days)) {
      return badRequest(
        "business_id and valid period_days (7|14|30|90) required",
      );
    }

    // 1. Auth: verify JWT + owner/manager membership in one call
    // business_id is verified against the DB — not blindly trusted from body
    const ctx = await requireOwnerOrManagerCtx(req, business_id);
    if (ctx instanceof Response) return ctx;
    const { userId, businessId } = ctx;

    // 2. Check cache — ai_finance notification from last 6 hours
    const cacheThreshold = new Date(
      Date.now() - CACHE_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const { data: cached } = await supabaseAdmin
      .from("notifications")
      .select("metadata")
      .eq("business_id", businessId)
      .eq("type", "ai_finance")
      .gte("created_at", cacheThreshold)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (
      cached?.metadata &&
      (cached.metadata as Record<string, unknown>).period_days === period_days &&
      !question
    ) {
      return new Response(
        JSON.stringify({
          insights: (cached.metadata as Record<string, unknown>).insights,
          cached: true,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 4. Gather finance context
    const context = await gatherFinanceContext(businessId, period_days);

    // 5. Call Anthropic
    const insights = await callAnthropic(
      context as unknown as Record<string, unknown>,
      question,
    );

    // 6. Store in notifications
    await supabaseAdmin.from("notifications").insert({
      business_id: businessId,
      user_id: userId,
      type: "ai_finance",
      title: "AI Finance Insights",
      body: `Generated ${insights.length} financial insights for the last ${period_days} days`,
      metadata: { insights, period_days },
    });

    return new Response(
      JSON.stringify({ insights, cached: false }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("ai-finance error:", err);
    return serverError(
      err instanceof Error ? err.message : "Internal server error",
    );
  }
}));
