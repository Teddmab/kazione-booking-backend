import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { badRequest, serverError } from "../_shared/errors.ts";
import { requireOwnerOrManagerCtx } from "../_shared/auth.ts";
import { withLogging } from "../_shared/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InsightItem {
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

// ---------------------------------------------------------------------------
// Context gathering — aggregated metrics only, NO PII
// ---------------------------------------------------------------------------

async function gatherContext(businessId: string, days: number) {
  const { from, to } = periodRange(days);

  // 1. Revenue summary (RPC)
  const { data: revenue, error: e1 } = await supabaseAdmin.rpc("get_revenue_summary", {
    p_business_id: businessId,
    p_start_date: from,
    p_end_date: to,
  });
  if (e1) throw e1;

  // 2. Staff performance (RPC)
  const { data: staffPerf, error: e2 } = await supabaseAdmin.rpc(
    "get_staff_performance",
    {
      p_business_id: businessId,
      p_start_date: from,
      p_end_date: to,
    },
  );
  if (e2) throw e2;

  // 3. Appointment stats
  const { data: appts, error: e3 } = await supabaseAdmin
    .from("appointments")
    .select("id, status")
    .eq("business_id", businessId)
    .gte("starts_at", from)
    .lte("starts_at", to);
  if (e3) throw e3;

  const total = appts?.length ?? 0;
  const completed = appts?.filter((a: { status: string }) => a.status === "completed").length ?? 0;
  const cancelled = appts?.filter((a: { status: string }) => a.status === "cancelled").length ?? 0;
  const noShows = appts?.filter((a: { status: string }) => a.status === "no_show").length ?? 0;

  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
  const noShowRate = total > 0 ? Math.round((noShows / total) * 100) : 0;

  // 4. Client metrics (new vs repeat)
  const { count: newClientsCount, error: e4 } = await supabaseAdmin
    .from("clients")
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId)
    .gte("created_at", from)
    .lte("created_at", to);
  if (e4) throw e4;

  const { data: clientAppts, error: e5 } = await supabaseAdmin
    .from("appointments")
    .select("client_id")
    .eq("business_id", businessId)
    .eq("status", "completed")
    .gte("starts_at", from)
    .lte("starts_at", to);
  if (e5) throw e5;

  const clientIds = new Set((clientAppts ?? []).map((a: { client_id: string }) => a.client_id));
  // Clients with 2+ completed appointments in the period = repeat
  const clientBookingCounts = new Map<string, number>();
  for (const a of clientAppts ?? []) {
    clientBookingCounts.set(a.client_id, (clientBookingCounts.get(a.client_id) ?? 0) + 1);
  }
  const repeatClients = [...clientBookingCounts.values()].filter((c) => c >= 2).length;
  const repeatRate =
    clientIds.size > 0 ? Math.round((repeatClients / clientIds.size) * 100) : 0;

  // 5. Top and bottom services by booking count
  const { data: serviceBookings, error: e6 } = await supabaseAdmin
    .from("appointments")
    .select("service_id, services!inner(name)")
    .eq("business_id", businessId)
    .gte("starts_at", from)
    .lte("starts_at", to);
  if (e6) throw e6;

  const serviceCounts = new Map<string, { name: string; count: number }>();
  for (const sb of serviceBookings ?? []) {
    const svc = sb.services as unknown as { name: string };
    const key = sb.service_id as string;
    const entry = serviceCounts.get(key) ?? { name: svc.name, count: 0 };
    entry.count += 1;
    serviceCounts.set(key, entry);
  }
  const sortedServices = [...serviceCounts.values()].sort((a, b) => b.count - a.count);
  const top5 = sortedServices.slice(0, 5);
  const bottom5 = sortedServices.slice(-5).reverse();

  // 6. Review metrics
  const { data: reviews, error: e7 } = await supabaseAdmin
    .from("reviews")
    .select("rating, comment")
    .eq("business_id", businessId)
    .eq("is_public", true)
    .gte("created_at", from)
    .lte("created_at", to)
    .order("created_at", { ascending: false })
    .limit(20);
  if (e7) throw e7;

  const avgRating =
    reviews && reviews.length > 0
      ? Math.round(
          (reviews.reduce((sum: number, r: { rating: number }) => sum + r.rating, 0) /
            reviews.length) *
            10,
        ) / 10
      : null;

  // Only include a brief sentiment indicator, no client PII
  const positiveCount = reviews?.filter((r: { rating: number }) => r.rating >= 4).length ?? 0;
  const negativeCount = reviews?.filter((r: { rating: number }) => r.rating <= 2).length ?? 0;

  return {
    period: { from, to, days },
    revenue: revenue ?? null,
    staff_performance: (staffPerf ?? []).map(
      (s: { display_name: string; bookings: number; revenue: number; avg_rating: number; completion_rate: number }) => ({
        name: s.display_name,
        bookings: s.bookings,
        revenue: s.revenue,
        avg_rating: s.avg_rating,
        completion_rate: s.completion_rate,
      }),
    ),
    appointments: {
      total,
      completed,
      cancelled,
      no_shows: noShows,
      completion_rate_pct: completionRate,
      no_show_rate_pct: noShowRate,
    },
    clients: {
      new_clients: newClientsCount ?? 0,
      unique_clients: clientIds.size,
      repeat_clients: repeatClients,
      repeat_rate_pct: repeatRate,
    },
    services: { top_5: top5, bottom_5: bottom5 },
    reviews: {
      count: reviews?.length ?? 0,
      avg_rating: avgRating,
      positive_count: positiveCount,
      negative_count: negativeCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Anthropic call
// ---------------------------------------------------------------------------

async function callAnthropic(
  context: Record<string, unknown>,
  question?: string,
): Promise<InsightItem[]> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const userMessage = question
    ? `Here are the business metrics:\n${JSON.stringify(context, null, 2)}\n\nQuestion: ${question}`
    : `Here are the business metrics:\n${JSON.stringify(context, null, 2)}\n\nGenerate top insights for this business.`;

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
        "You are KaziOne AI, a business intelligence assistant for beauty and wellness businesses. " +
        "Analyze the provided metrics and return actionable insights as JSON only. " +
        "Be specific, practical, and data-driven. Never invent data not in the provided metrics. " +
        'Respond with a JSON object: { "insights": [{ "type": string, "title": string, "description": string, "recommendation": string, "priority": "high"|"medium"|"low" }] }. ' +
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

  // Extract JSON from the response (handle possible markdown code fences)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No valid JSON in AI response");

  const parsed = JSON.parse(jsonMatch[0]);
  return (parsed.insights ?? []) as InsightItem[];
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

Deno.serve(withLogging("ai-insights", async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (req.method !== "POST") {
      return badRequest("Method not allowed");
    }

    const body = (await req.json()) as RequestBody;
    const { business_id, period_days, question } = body;

    if (!business_id || !VALID_PERIODS.includes(period_days)) {
      return badRequest("business_id and valid period_days (7|14|30|90) required");
    }

    // 1. Auth: verify JWT + owner/manager membership in one call
    // business_id is verified against the DB — not blindly trusted from body
    const ctx = await requireOwnerOrManagerCtx(req, business_id);
    if (ctx instanceof Response) return ctx;
    const { userId, businessId } = ctx;

    // 2. Check cache — ai_insight notification from last 6 hours with same period
    const cacheThreshold = new Date(
      Date.now() - CACHE_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const { data: cached } = await supabaseAdmin
      .from("notifications")
      .select("metadata")
      .eq("business_id", businessId)
      .eq("type", "ai_insight")
      .gte("created_at", cacheThreshold)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (
      cached?.metadata &&
      (cached.metadata as Record<string, unknown>).period_days === period_days &&
      !question // Only use cache for default insights, not custom questions
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

    // 4. Gather context
    const context = await gatherContext(businessId, period_days);

    // 5. Call Anthropic
    const insights = await callAnthropic(
      context as unknown as Record<string, unknown>,
      question,
    );

    // 6. Store in notifications
    await supabaseAdmin.from("notifications").insert({
      business_id: businessId,
      user_id: userId,
      type: "ai_insight",
      title: "AI Business Insights",
      body: `Generated ${insights.length} insights for the last ${period_days} days`,
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
    console.error("ai-insights error:", err);
    return serverError(
      err instanceof Error ? err.message : "Internal server error",
    );
  }
}));
