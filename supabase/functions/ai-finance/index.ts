import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeadersFor, handleCors } from "../_shared/cors.ts";
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
  action?: string;
  year?: number;
  period_days?: 7 | 14 | 30 | 90;
  question?: string;
  focus?: string;
  context?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tax review types
// ---------------------------------------------------------------------------

interface TaxReviewIssue {
  severity: "high" | "medium" | "low";
  title: string;
  action: string;
}

interface TaxReviewObligation {
  type: string;
  amount: number;
  note: string;
}

interface TaxReviewResult {
  readiness_score: number;
  status: "ready" | "needs_attention" | "not_ready";
  issues: TaxReviewIssue[];
  estimated_obligations: TaxReviewObligation[];
  red_flags: string[];
  summary: string;
  cached: boolean;
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
      model: "claude-sonnet-4-6",
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
// Debt strategy — uses caller-supplied context, no RPC needed
// ---------------------------------------------------------------------------

async function callAnthropicDebtStrategy(
  context: Record<string, unknown>,
): Promise<FinanceInsightItem[]> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system:
        "You are KaziOne AI Finance Advisor for beauty and wellness businesses. " +
        "Analyze the provided debt summary and return actionable debt management insights as JSON only. " +
        "Focus on: repayment prioritization, cash flow impact of monthly minimums, debt reduction strategies, " +
        "overdue debt urgency, and interest cost optimization. Be specific and data-driven. " +
        'Respond with a JSON object: { "insights": [{ "type": "debt_priority"|"cash_flow"|"repayment_strategy"|"overdue_alert"|"interest_optimization", "title": string, "description": string, "recommendation": string, "priority": "high"|"medium"|"low" }] }. ' +
        "Return 3-5 insights. Do not include any text outside the JSON object.",
      messages: [
        {
          role: "user",
          content: `Debt summary:\n${JSON.stringify(context, null, 2)}\n\nProvide actionable debt management strategies.`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? "";
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
    const { business_id, action, year, period_days, question, focus, context: focusContext } = body;

    if (!business_id) return badRequest("business_id is required");

    // 1. Auth: verify JWT + owner/manager membership in one call
    const ctx = await requireOwnerOrManagerCtx(req, business_id);
    if (ctx instanceof Response) return ctx;
    const { userId, businessId } = ctx;

    // ── Tax review path ───────────────────────────────────────────────────────
    if (action === "tax-review") {
      if (!year || year < 2020) return badRequest("valid year is required for tax-review");

      const CACHE_KEY = `ai_tax_review_${year}`;
      const cache24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Check 24h cache (unless question override provided)
      if (!question) {
        const { data: cached } = await supabaseAdmin
          .from("notifications")
          .select("metadata")
          .eq("business_id", businessId)
          .eq("type", CACHE_KEY)
          .gte("created_at", cache24h)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (cached?.metadata) {
          const m = cached.metadata as Record<string, unknown>;
          return new Response(
            JSON.stringify({ ...(m.result as object), cached: true }),
            { status: 200, headers: { ...corsHeadersFor(req), "Content-Type": "application/json" } },
          );
        }
      }

      // Gather annual data from DB directly
      const yearStart = `${year}-01-01`;
      const yearEnd = `${year + 1}-01-01`;

      const [apptR, payR, expR, commPaidR, bankR, bizR] = await Promise.all([
        supabaseAdmin.from("appointments").select("price").eq("business_id", businessId).eq("status", "completed").is("deleted_at", null).gte("starts_at", yearStart).lt("starts_at", yearEnd),
        supabaseAdmin.from("payments").select("tax_amount").eq("business_id", businessId).eq("status", "paid").gte("paid_at", yearStart).lt("paid_at", yearEnd),
        supabaseAdmin.from("expenses").select("amount, tax_amount, receipt_url").eq("business_id", businessId).is("deleted_at", null).gte("date", yearStart).lt("date", yearEnd),
        supabaseAdmin.from("appointments").select("commission_amount_paid").eq("business_id", businessId).eq("status", "completed").not("commission_paid_at", "is", null).gte("commission_paid_at", yearStart).lt("commission_paid_at", yearEnd),
        supabaseAdmin.from("bank_transactions").select("date").eq("business_id", businessId).gte("date", yearStart).lt("date", yearEnd),
        supabaseAdmin.from("businesses").select("name, commission_rate").eq("id", businessId).maybeSingle(),
      ]);

      const totalGross = (apptR.data ?? []).reduce((s, a) => s + Number(a.price ?? 0), 0);
      const vatCollected = (payR.data ?? []).reduce((s, p) => s + Number(p.tax_amount ?? 0), 0);
      const netRevenue = totalGross - vatCollected;
      const totalExpenses = (expR.data ?? []).reduce((s, e) => s + Number(e.amount ?? 0), 0);
      const vatDeductible = (expR.data ?? []).reduce((s, e) => s + Number(e.tax_amount ?? 0), 0);
      const missingInvoices = (expR.data ?? []).filter(e => !e.receipt_url).length;
      const commPaid = (commPaidR.data ?? []).reduce((s, a) => s + Number(a.commission_amount_paid ?? 0), 0);
      const netProfit = netRevenue - (totalExpenses - vatDeductible) - commPaid;

      const monthsWithData = new Set((bankR.data ?? []).map(r => new Date(r.date as string).getMonth()));
      const coveredMonths = monthsWithData.size;
      const bizName = (bizR.data as Record<string, unknown> | null)?.name as string ?? "the business";

      const prompt = question
        ? `Annual tax data for ${bizName} (Estonian OÜ), ${year}:
Revenue (gross): €${totalGross.toFixed(2)}
VAT collected: €${vatCollected.toFixed(2)}
Net revenue: €${netRevenue.toFixed(2)}
Total expenses: €${totalExpenses.toFixed(2)}
VAT deductible: €${vatDeductible.toFixed(2)}
Missing invoices: ${missingInvoices}
Commissions paid: €${commPaid.toFixed(2)}
Net profit: €${netProfit.toFixed(2)}
VAT net payable: €${(vatCollected - vatDeductible).toFixed(2)}
Bank statement coverage: ${coveredMonths}/12 months

Question: ${question}

Answer concisely as a certified Estonian tax accountant. Plain text, no JSON.`
        : `You are a certified Estonian tax accountant reviewing year-end readiness for an OÜ.

Business: ${bizName}, Tallinn, Estonia
Tax year: ${year}
VAT registered: yes

Annual financial summary:
Revenue (gross, incl. VAT): €${totalGross.toFixed(2)}
VAT collected on sales: €${vatCollected.toFixed(2)}
Net revenue: €${netRevenue.toFixed(2)}
Expenses (gross): €${totalExpenses.toFixed(2)}
VAT on deductible expenses: €${vatDeductible.toFixed(2)}
Expenses missing invoice/receipt: ${missingInvoices}
Staff commissions paid: €${commPaid.toFixed(2)}
Net profit (pre-tax): €${netProfit.toFixed(2)}
VAT balance (payable): €${(vatCollected - vatDeductible).toFixed(2)}
Bank statements uploaded: ${coveredMonths}/12 months

Respond ONLY with this exact JSON (no other text):
{
  "readiness_score": <0-100>,
  "status": "<ready|needs_attention|not_ready>",
  "issues": [
    { "severity": "<high|medium|low>", "title": "<short title>", "action": "<what to do>" }
  ],
  "estimated_obligations": [
    { "type": "<obligation name>", "amount": <number>, "note": "<brief note>" }
  ],
  "red_flags": ["<flag 1>", "<flag 2>"],
  "summary": "<2-3 sentence narrative>"
}`;

      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) return serverError("ANTHROPIC_API_KEY not configured");

      const aiRes = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1500,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!aiRes.ok) {
        const errBody = await aiRes.text();
        return serverError(`Anthropic API error ${aiRes.status}: ${errBody}`);
      }

      const aiData = await aiRes.json();
      const rawText: string = aiData.content?.[0]?.text ?? "";

      let result: TaxReviewResult;
      if (question) {
        // For follow-up questions return plain text answer
        result = {
          readiness_score: 0,
          status: "needs_attention",
          issues: [],
          estimated_obligations: [],
          red_flags: [],
          summary: rawText.trim(),
          cached: false,
        };
      } else {
        try {
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error("No JSON found");
          const parsed = JSON.parse(jsonMatch[0]);
          result = {
            readiness_score: Number(parsed.readiness_score ?? 0),
            status: parsed.status ?? "needs_attention",
            issues: parsed.issues ?? [],
            estimated_obligations: parsed.estimated_obligations ?? [],
            red_flags: parsed.red_flags ?? [],
            summary: parsed.summary ?? "",
            cached: false,
          };
        } catch {
          result = {
            readiness_score: 0,
            status: "needs_attention",
            issues: [{ severity: "high", title: "AI review failed to parse", action: "Try again" }],
            estimated_obligations: [],
            red_flags: [],
            summary: rawText.trim(),
            cached: false,
          };
        }

        // Cache the successful structured result
        await supabaseAdmin.from("notifications").insert({
          business_id: businessId,
          user_id: userId,
          type: CACHE_KEY,
          title: `AI Tax Review ${year}`,
          body: `Readiness score: ${result.readiness_score}/100`,
          metadata: { result },
          is_read: true,
        });
      }

      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeadersFor(req), "Content-Type": "application/json" } },
      );
    }

    // Fast-path: caller provides pre-gathered context for any focus value.
    // Skips the broken RPC-based context gathering entirely.
    const isFastPath = focus !== undefined && focusContext !== undefined;

    if (!isFastPath && !VALID_PERIODS.includes(period_days!)) {
      return badRequest("business_id and valid period_days (7|14|30|90) required");
    }

    // ── Focus fast-path (uses caller context, skips RPC gathering) ──────────
    if (isFastPath) {
      const notifType = `ai_${focus}`;
      const cacheMinutes = 30;
      const fastCacheThreshold = new Date(Date.now() - cacheMinutes * 60 * 1000).toISOString();

      const { data: fastCached } = await supabaseAdmin
        .from("notifications")
        .select("metadata")
        .eq("business_id", businessId)
        .eq("type", notifType)
        .gte("created_at", fastCacheThreshold)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fastCached?.metadata) {
        return new Response(
          JSON.stringify({
            insights: (fastCached.metadata as Record<string, unknown>).insights,
            cached: true,
          }),
          { status: 200, headers: { ...corsHeadersFor(req), "Content-Type": "application/json" } },
        );
      }

      const fastInsights = focus === "debt_strategy"
        ? await callAnthropicDebtStrategy(focusContext!)
        : await callAnthropic(focusContext!, question);

      await supabaseAdmin.from("notifications").insert({
        business_id: businessId,
        user_id: userId,
        type: notifType,
        title: `AI ${focus.replace(/_/g, " ")} analysis`,
        body: `Generated ${fastInsights.length} insights`,
        metadata: { insights: fastInsights },
        is_read: true,
      });

      return new Response(
        JSON.stringify({ insights: fastInsights, cached: false }),
        { status: 200, headers: { ...corsHeadersFor(req), "Content-Type": "application/json" } },
      );
    }

    // ── Regular finance analysis path ────────────────────────────────────────

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
          headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
        },
      );
    }

    // 4. Gather finance context
    const financeContext = await gatherFinanceContext(businessId, period_days!);

    // 5. Call Anthropic
    const insights = await callAnthropic(
      financeContext as unknown as Record<string, unknown>,
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
        headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
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
