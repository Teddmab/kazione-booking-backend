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

interface ServiceSuggestion {
  field: "name" | "description" | "price" | "duration_minutes" | "staff_commission";
  suggested_value: string | null;
  reason: string;
  // Commission-specific extras (populated when field === "staff_commission")
  suggested_commission_type?: "percentage" | "fixed";
  suggested_commission_value?: number;
}

interface ServiceInsight {
  service_name: string;
  severity: "ok" | "warning" | "error";
  issues: string[];
  suggestions: ServiceSuggestion[];
}

interface ServiceAnalysisResponse {
  analysis: ServiceInsight[];
  summary: string;
  cached: boolean;
}

interface RequestBody {
  business_id: string;
  period_days?: 7 | 14 | 30 | 90;
  action?: string;
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
      model: "claude-sonnet-4-6",
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
    console.error("[ai-insights] Anthropic API error (business)", res.status, errBody.slice(0, 300));
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
// Service catalog analysis
// ---------------------------------------------------------------------------

async function gatherServices(businessId: string) {
  const { data, error } = await supabaseAdmin
    .from("services")
    .select("id, name, description, price, duration_minutes, is_active, category_id, staff_commission_type, staff_commission_value, updated_at, service_categories(name)")
    .eq("business_id", businessId)
    .eq("is_active", true)
    .order("display_order", { ascending: true });
  if (error) throw error;

  return (data ?? []).map((svc: Record<string, unknown>) => {
    const cat = svc.service_categories as { name: string } | null;
    return {
      id: svc.id as string,
      name: svc.name as string,
      description: (svc.description ?? "") as string,
      price: +(svc.price as number),
      duration_minutes: svc.duration_minutes as number,
      category: cat?.name ?? null,
      staff_commission_type: (svc.staff_commission_type ?? "none") as string,
      staff_commission_value: svc.staff_commission_value != null ? +(svc.staff_commission_value as number) : null,
      updated_at: svc.updated_at as string,
    };
  });
}

function serviceHash(svc: {
  name: string; price: number; duration_minutes: number;
  description: string; staff_commission_type: string; staff_commission_value: number | null;
  updated_at: string;
}): string {
  return `${svc.updated_at}|${svc.name}|${svc.price}|${svc.duration_minutes}|${svc.description.length}|${svc.staff_commission_type}|${svc.staff_commission_value}`;
}

const SERVICE_CACHE_HOURS = 24;

async function callAnthropicServices(
  services: Array<{
    name: string; description: string; price: number;
    duration_minutes: number; category: string | null;
    staff_commission_type: string; staff_commission_value: number | null;
  }>,
): Promise<ServiceAnalysisResponse> {
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
      max_tokens: 4000,
      system:
        "You are KaziOne AI, a business analyst for beauty and wellness salons. " +
        "Analyze the service catalog and flag real issues. Keep all text values short (max 20 words each). " +
        "Check each service for: (1) missing/very short description (<8 words), (2) price anomaly (0 or very different from similar services), (3) missing category, (4) duration mismatch for service type, (5) no staff commission set (recommend industry-standard rate). " +
        "Industry commission norms for Estonia/EU salons: hair services 30-40%, nail services 35-45%, massage/spa 40-50%, other beauty 30-40%. " +
        'Output ONLY valid JSON matching this exact schema (no text outside the object): { "analysis": [{ "service_name": string, "severity": "ok"|"warning"|"error", "issues": string[], "suggestions": [{ "field": "name"|"description"|"price"|"duration_minutes"|"staff_commission", "suggested_value": string|null, "reason": string, "suggested_commission_type": "percentage"|"fixed"|null, "suggested_commission_value": number|null }] }], "summary": string }. ' +
        "Rules: description suggestions must be ≤20 words. For staff_commission field: set suggested_commission_type to 'percentage', suggested_commission_value to the recommended %, suggested_value to null. For price/duration anomalies set suggested_value to null. Services that look good: severity=ok, empty issues and suggestions arrays.",
      messages: [
        {
          role: "user",
          content: `Analyze this service catalog:\n${JSON.stringify(services)}`,
        },
        {
          role: "assistant",
          content: "{",
        },
      ],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error("[ai-insights] Anthropic API error (services)", res.status, errBody.slice(0, 300));
    throw new Error(`Anthropic API error ${res.status}: ${errBody}`);
  }

  const data = await res.json();
  // Prepend the '{' we sent as the assistant prefill
  const text = "{" + (data.content?.[0]?.text ?? "");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Attempt to salvage truncated JSON by extracting as much analysis as possible
    const partial = text.match(/\{[\s\S]*/)?.[0] ?? "{}";
    try {
      // Try repairing common truncation: close unclosed arrays/objects
      const repaired = partial
        .replace(/,\s*$/, "")          // trailing comma
        .replace(/\[\s*$/, "[]")       // open array at end
        + (partial.split("{").length - partial.split("}").length > 0
          ? "}".repeat(partial.split("{").length - partial.split("}").length)
          : "");
      parsed = JSON.parse(repaired);
    } catch {
      throw new Error(`AI returned invalid JSON. Raw: ${text.slice(0, 200)}`);
    }
  }

  return {
    analysis: (parsed.analysis ?? []) as ServiceInsight[],
    summary: (parsed.summary ?? "") as string,
    cached: false,
  };
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
    const { business_id, period_days, action, question } = body;

    if (!business_id) {
      return badRequest("business_id is required");
    }

    // 1. Auth: verify JWT + owner/manager membership in one call
    const ctx = await requireOwnerOrManagerCtx(req, business_id);
    if (ctx instanceof Response) return ctx;
    const { userId, businessId } = ctx;

    // ── Service catalog analysis ─────────────────────────────────────────
    if (action === "services") {
      const services = await gatherServices(businessId);
      if (services.length === 0) {
        return new Response(
          JSON.stringify({ analysis: [], summary: "No active services found.", cached: false, cached_services: [] }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Build current hash map: service id → hash
      const currentHashes = new Map(services.map((s) => [s.id, serviceHash(s)]));

      // Load latest cache entry for this business (within 24h)
      const cacheThreshold = new Date(Date.now() - SERVICE_CACHE_HOURS * 3600000).toISOString();
      const { data: cacheEntry } = await supabaseAdmin
        .from("notifications")
        .select("metadata, created_at")
        .eq("business_id", businessId)
        .eq("type", "ai_service_analysis")
        .gte("created_at", cacheThreshold)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const cachedMeta = (cacheEntry?.metadata ?? null) as Record<string, unknown> | null;
      const cachedHashes = (cachedMeta?.service_hashes ?? {}) as Record<string, string>;
      const cachedAnalysis = (cachedMeta?.analysis ?? []) as ServiceInsight[];
      const cachedAt = cacheEntry?.created_at as string | undefined;

      // Split services: those whose hash matches cached vs. those that changed/are new
      const staleServices = services.filter((s) => cachedHashes[s.id] !== currentHashes.get(s.id));
      const cachedServiceNames = services
        .filter((s) => cachedHashes[s.id] === currentHashes.get(s.id))
        .map((s) => s.name);

      let freshAnalysis: ServiceInsight[] = [];
      let summary = (cachedMeta?.summary as string | undefined) ?? "";

      if (staleServices.length === 0 && cachedAnalysis.length > 0) {
        // Everything cached — return immediately
        return new Response(
          JSON.stringify({
            analysis: cachedAnalysis,
            summary,
            cached: true,
            cached_services: cachedServiceNames.map((name) => ({ name, analyzed_at: cachedAt })),
          }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      // Call AI only for stale/new services; preserve cached insights for unchanged ones
      const servicesToAnalyze = staleServices.length > 0 ? staleServices : services;
      const freshResult = await callAnthropicServices(servicesToAnalyze);
      freshAnalysis = freshResult.analysis;
      summary = freshResult.summary || summary;

      // Merge: cached insights for unchanged services + fresh insights for changed services
      const freshNames = new Set(staleServices.map((s) => s.name.toLowerCase()));
      const preservedInsights = cachedAnalysis.filter(
        (item) => !freshNames.has(item.service_name.toLowerCase()),
      );
      const mergedAnalysis = [...preservedInsights, ...freshAnalysis];

      // Persist merged cache (upsert-style: insert new row)
      const newHashes: Record<string, string> = {};
      for (const [id, hash] of currentHashes) newHashes[id] = hash;

      await supabaseAdmin.from("notifications").insert({
        business_id: businessId,
        user_id: userId,
        type: "ai_service_analysis",
        title: "AI Service Analysis",
        body: `Analysed ${staleServices.length} service(s); ${cachedServiceNames.length} from cache`,
        metadata: {
          service_hashes: newHashes,
          analysis: mergedAnalysis,
          summary,
        },
        is_read: true,
      });

      return new Response(
        JSON.stringify({
          analysis: mergedAnalysis,
          summary,
          cached: false,
          cached_services: cachedServiceNames.map((name) => ({ name, analyzed_at: cachedAt })),
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Business insights (default) ──────────────────────────────────────
    if (!period_days || !VALID_PERIODS.includes(period_days)) {
      return badRequest("valid period_days (7|14|30|90) required for business insights");
    }

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
