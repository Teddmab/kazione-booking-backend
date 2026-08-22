-- 118_monitoring_mvp.sql
--
-- S76: Monitoring MVP — request/error/latency charts + an uptime status
-- board for the admin portal's new Monitoring page.
--
-- 1. platform_metrics_hourly — one row per (function_name, hour), updated
--    by an atomic upsert RPC on every single request (not just 5xx, unlike
--    platform_error_log from S75). Deliberately a rollup, not a per-request
--    log table — an edge function handling real booking traffic could see
--    thousands of requests/day; a raw per-request table would grow
--    unbounded and make "last 30 days" queries slow. Hourly buckets keep
--    30 days of history at (functions × 24 × 30) rows — trivially small.
--
-- 2. platform_endpoint_health — latest + historical result of the health
--    checks platform-alert-digest (S75) already runs every 15 minutes,
--    now persisted so the Monitoring page can show an uptime status board
--    instead of that check result only ever reaching an alert email.

CREATE TABLE IF NOT EXISTS platform_metrics_hourly (
  function_name     text        NOT NULL,
  hour_bucket        timestamptz NOT NULL,
  request_count      int         NOT NULL DEFAULT 0,
  error_count        int         NOT NULL DEFAULT 0,
  total_duration_ms  bigint      NOT NULL DEFAULT 0,
  PRIMARY KEY (function_name, hour_bucket)
);

CREATE INDEX IF NOT EXISTS idx_platform_metrics_hourly_bucket
  ON platform_metrics_hourly (hour_bucket DESC);

ALTER TABLE platform_metrics_hourly ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_platform_metrics_hourly"
  ON platform_metrics_hourly FOR SELECT
  USING (is_platform_admin());

-- Atomic increment — called fire-and-forget from _shared/logger.ts on every
-- request. SECURITY DEFINER + a narrow signature so it can be exposed to
-- service_role without needing a broader table-level UPDATE grant.
CREATE OR REPLACE FUNCTION record_platform_metric(
  p_function_name text,
  p_is_error      boolean,
  p_duration_ms   int
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO platform_metrics_hourly (function_name, hour_bucket, request_count, error_count, total_duration_ms)
  VALUES (p_function_name, date_trunc('hour', now()), 1, CASE WHEN p_is_error THEN 1 ELSE 0 END, GREATEST(p_duration_ms, 0))
  ON CONFLICT (function_name, hour_bucket) DO UPDATE SET
    request_count     = platform_metrics_hourly.request_count + 1,
    error_count       = platform_metrics_hourly.error_count + CASE WHEN p_is_error THEN 1 ELSE 0 END,
    total_duration_ms = platform_metrics_hourly.total_duration_ms + GREATEST(p_duration_ms, 0);
$$;

CREATE TABLE IF NOT EXISTS platform_endpoint_health (
  endpoint_name text        NOT NULL,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  status        text        NOT NULL, -- 'up' | 'down'
  http_status   int,                  -- null when unreachable (network error/timeout)
  PRIMARY KEY (endpoint_name, checked_at)
);

CREATE INDEX IF NOT EXISTS idx_platform_endpoint_health_checked_at
  ON platform_endpoint_health (checked_at DESC);

ALTER TABLE platform_endpoint_health ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_read_platform_endpoint_health"
  ON platform_endpoint_health FOR SELECT
  USING (is_platform_admin());

COMMENT ON TABLE platform_metrics_hourly IS
  'Hourly request/error/latency rollup per edge function, written via record_platform_metric() from every withLogging call. Powers the admin Monitoring dashboard charts.';
COMMENT ON TABLE platform_endpoint_health IS
  'History of platform-alert-digest''s health-check sweep (every 15 min). Powers the admin Monitoring page''s uptime status board.';
