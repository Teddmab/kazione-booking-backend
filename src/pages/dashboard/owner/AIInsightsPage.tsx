import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAuth, useTenant } from "../../../hooks/useAuth";
import { supabase } from "../../../lib/supabase";
import { NetworkError } from "../../../types/api";

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

interface InsightsResponse {
  insights: InsightItem[];
  cached: boolean;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

const FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

async function fetchInsights(
  businessId: string,
  periodDays: number,
  question?: string,
): Promise<InsightsResponse> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const res = await fetch(`${FUNCTIONS_URL}/ai-insights`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session?.access_token ?? ""}`,
    },
    body: JSON.stringify({
      business_id: businessId,
      period_days: periodDays,
      question: question || undefined,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new NetworkError(
      body?.error?.message ?? res.statusText,
      res.status,
    );
  }

  return res.json() as Promise<InsightsResponse>;
}

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

const PRIORITY_STYLES: Record<string, string> = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-yellow-100 text-yellow-700 border-yellow-200",
  low: "bg-green-100 text-green-700 border-green-200",
};

const PRIORITY_LABELS: Record<string, string> = {
  high: "High Priority",
  medium: "Medium",
  low: "Low",
};

const TYPE_ICONS: Record<string, string> = {
  revenue: "📈",
  staffing: "👥",
  retention: "🔄",
  operations: "⚙️",
  marketing: "📣",
  service_performance: "⭐",
  client_engagement: "💬",
  financial_health: "💰",
  tax_prep: "📋",
  cost_reduction: "✂️",
  bookkeeping_gap: "📝",
  revenue_trend: "📊",
  profit_optimization: "🎯",
};

// ---------------------------------------------------------------------------
// Period selector
// ---------------------------------------------------------------------------

const PERIODS = [
  { value: 7, label: "7 days" },
  { value: 14, label: "14 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
] as const;

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function InsightCard({ insight }: { insight: InsightItem }) {
  const icon = TYPE_ICONS[insight.type] ?? "💡";
  const priorityCls = PRIORITY_STYLES[insight.priority] ?? PRIORITY_STYLES.medium;
  const priorityLabel = PRIORITY_LABELS[insight.priority] ?? insight.priority;

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">{icon}</span>
          <h3 className="font-semibold">{insight.title}</h3>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${priorityCls}`}
        >
          {priorityLabel}
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{insight.description}</p>
      <div className="mt-3 rounded-md bg-accent/50 p-3">
        <p className="text-xs font-medium text-accent-foreground">
          💡 Recommendation
        </p>
        <p className="mt-0.5 text-sm">{insight.recommendation}</p>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-lg border bg-card p-5">
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded bg-muted" />
            <div className="h-5 w-48 rounded bg-muted" />
          </div>
          <div className="mt-3 space-y-2">
            <div className="h-3 w-full rounded bg-muted" />
            <div className="h-3 w-3/4 rounded bg-muted" />
          </div>
          <div className="mt-3 h-16 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center text-center">
      <span className="text-5xl">🤖</span>
      <h3 className="mt-4 text-lg font-semibold">AI Business Insights</h3>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        Select a time period and click "Generate Insights" to get AI-powered
        analysis of your business performance.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function AIInsightsPage() {
  const { user } = useAuth();
  const { data: tenant } = useTenant(user?.id);
  const businessId = tenant?.businessId;

  const [period, setPeriod] = useState<number>(30);
  const [question, setQuestion] = useState("");
  const [insights, setInsights] = useState<InsightItem[] | null>(null);
  const [wasCached, setWasCached] = useState(false);

  const mutation = useMutation<InsightsResponse, Error, void>({
    mutationFn: () => fetchInsights(businessId!, period, question),
    onSuccess: (data) => {
      setInsights(data.insights);
      setWasCached(data.cached);
    },
  });

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold">AI Business Insights</h1>
        <p className="text-sm text-muted-foreground">
          Get AI-powered analysis and recommendations for your business.
        </p>
      </div>

      {/* ── Controls ────────────────────────────────────────── */}
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          {/* Period selector */}
          <div className="space-y-1">
            <span className="text-sm font-medium">Time Period</span>
            <div className="flex gap-1">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPeriod(p.value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    period === p.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-accent text-accent-foreground hover:bg-accent/80"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom question */}
          <div className="flex-1 space-y-1">
            <span className="text-sm font-medium">
              Ask a question <span className="font-normal text-muted-foreground">(optional)</span>
            </span>
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. Why are cancellations increasing this month?"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(e) => {
                if (e.key === "Enter" && businessId) mutation.mutate();
              }}
            />
          </div>

          {/* Generate button */}
          <button
            type="button"
            disabled={!businessId || mutation.isPending}
            onClick={() => mutation.mutate()}
            className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {mutation.isPending ? (
              <span className="flex items-center gap-2">
                <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground" />
                Analyzing…
              </span>
            ) : (
              "Generate Insights"
            )}
          </button>
        </div>

        {/* Error */}
        {mutation.isError && (
          <div className="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {mutation.error.message}
          </div>
        )}
      </div>

      {/* ── Cache indicator ─────────────────────────────────── */}
      {insights && wasCached && (
        <div className="flex items-center gap-2 rounded-md bg-blue-50 px-4 py-2 text-sm text-blue-700">
          <span>ℹ️</span>
          Showing cached insights from the last 6 hours. Generate again with a
          custom question to get fresh results.
        </div>
      )}

      {/* ── Results ─────────────────────────────────────────── */}
      {mutation.isPending ? (
        <LoadingSkeleton />
      ) : insights ? (
        insights.length > 0 ? (
          <div className="space-y-4">
            {/* Priority summary bar */}
            <div className="flex items-center gap-3 text-sm">
              <span className="font-medium">{insights.length} insights</span>
              <span className="text-muted-foreground">·</span>
              {["high", "medium", "low"].map((p) => {
                const count = insights.filter((i) => i.priority === p).length;
                if (count === 0) return null;
                return (
                  <span
                    key={p}
                    className={`rounded-full border px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[p]}`}
                  >
                    {count} {PRIORITY_LABELS[p]}
                  </span>
                );
              })}
            </div>

            {/* Insight cards — high priority first */}
            {[...insights]
              .sort((a, b) => {
                const order = { high: 0, medium: 1, low: 2 };
                return (order[a.priority] ?? 1) - (order[b.priority] ?? 1);
              })
              .map((insight, idx) => (
                <InsightCard key={idx} insight={insight} />
              ))}
          </div>
        ) : (
          <div className="py-12 text-center text-muted-foreground">
            No insights generated. Try a different time period.
          </div>
        )
      ) : (
        <EmptyState />
      )}
    </div>
  );
}
