-- ─────────────────────────────────────────────────────────────────────────────
-- 120 — Backfill pre-S59 "false UTC" appointment times to true UTC
--
-- S59's write-path fix (PR #185, merged 2026-08-22 ~09:27 UTC) changed
-- create-booking / appointments (POST + PATCH reschedule) / reschedule-booking
-- to store a true-UTC starts_at instead of a "false UTC" encoding of the
-- business's local wall-clock time (raw local digits + a literal "Z" —
-- see the old `${date}T${time}:00Z` in create-booking, replaced by
-- localWallClockToUtcIso()). Appointments created BEFORE that deploy still
-- have starts_at/ends_at stored in the old false-UTC encoding.
--
-- Once the S59 frontend PR (#246) shipped, every display path started
-- correctly assuming true-UTC semantics for EVERY row and converting via
-- the business's real timezone. For any pre-cutover row on a non-UTC
-- business, that conversion now applies a SECOND, incorrect shift on top
-- of data that was never true UTC — e.g. an Afrotouch (Europe/Tallinn,
-- UTC+3 in August) appointment booked for 09:00 local now displays as
-- 12:00 in the owner portal, even though nothing about the actual
-- appointment changed and the customer was correctly told 09:00.
--
-- Fix: reinterpret each pre-cutover row's stored (false-UTC) starts_at as
-- the business's own local wall-clock, and re-derive the true UTC instant.
-- Postgres's native `timestamp AT TIME ZONE zone` idiom does exactly this,
-- DST-aware per row (important for Tallinn: EET in winter, EEST in
-- summer) — the same idiom migration 113 already uses for
-- get_available_slots, and functionally identical to what
-- _shared/timezone.ts#localWallClockToUtcIso now does for new writes.
--
-- Cutover: set a few minutes BEFORE the actual PR-merge timestamp
-- (2026-08-22 09:27:03 UTC), not at or after it — erring toward leaving a
-- handful of boundary-adjacent rows unfixed (safe: they'd just need a
-- manual follow-up) rather than risking wrongly re-shifting a row the new
-- code had already written correctly (destructive: would introduce a NEW
-- corruption in currently-correct data). Businesses on UTC are excluded
-- entirely — a zero UTC offset makes false-UTC and true-UTC identical, so
-- this bug cannot affect them.
--
-- This is a direct correction of the stored instant, not a reschedule —
-- it never touches reschedule-booking or appointments' reschedule action,
-- so it triggers ZERO customer notifications.
--
-- Every affected row's old values are preserved in
-- s59_false_utc_backfill_audit below before the UPDATE runs, so this is
-- precisely reversible if the cutover turns out to need adjusting.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS s59_false_utc_backfill_audit (
  appointment_id  uuid PRIMARY KEY,
  old_starts_at   timestamptz NOT NULL,
  old_ends_at     timestamptz NOT NULL,
  new_starts_at   timestamptz NOT NULL,
  new_ends_at     timestamptz NOT NULL,
  business_id     uuid NOT NULL,
  business_tz     text NOT NULL,
  backfilled_at   timestamptz NOT NULL DEFAULT now()
);

-- Forensic-only: this table is never read via PostgREST/edge functions —
-- only ever queried directly (SQL editor) if a manual rollback is needed.
-- RLS with zero policies fully locks out anon/authenticated; only
-- service_role (which bypasses RLS) or a direct superuser session can read
-- it. Without this, migration 054's ALTER DEFAULT PRIVILEGES would leave it
-- readable by any authenticated user via PostgREST by default — the exact
-- gap migration 116 had to fix for admin_audit_log.
ALTER TABLE s59_false_utc_backfill_audit ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  v_cutover timestamptz := '2026-08-22T09:20:00Z';
  v_fixed_count int;
BEGIN
  -- Guard: don't run twice. If a prior run already populated the audit
  -- table, this migration is a no-op instead of silently re-shifting
  -- already-corrected rows on a second apply.
  IF EXISTS (SELECT 1 FROM s59_false_utc_backfill_audit LIMIT 1) THEN
    RAISE NOTICE 'S59 false-UTC backfill already applied (audit table non-empty) — skipping.';
    RETURN;
  END IF;

  INSERT INTO s59_false_utc_backfill_audit
    (appointment_id, old_starts_at, old_ends_at, new_starts_at, new_ends_at, business_id, business_tz)
  SELECT a.id,
         a.starts_at,
         a.ends_at,
         (a.starts_at::timestamp AT TIME ZONE b.timezone),
         (a.starts_at::timestamp AT TIME ZONE b.timezone) + (a.ends_at - a.starts_at),
         a.business_id,
         b.timezone
    FROM appointments a
    JOIN businesses b ON b.id = a.business_id
   WHERE a.created_at < v_cutover
     AND b.timezone IS NOT NULL
     AND b.timezone <> 'UTC'
     -- Skip rows where the "correction" would be a no-op (defensive; should
     -- never actually happen once the timezone <> 'UTC' filter is applied).
     AND (a.starts_at::timestamp AT TIME ZONE b.timezone) <> a.starts_at;

  UPDATE appointments a
     SET starts_at = aud.new_starts_at,
         ends_at   = aud.new_ends_at
    FROM s59_false_utc_backfill_audit aud
   WHERE a.id = aud.appointment_id;

  GET DIAGNOSTICS v_fixed_count = ROW_COUNT;
  RAISE NOTICE 'S59 false-UTC backfill: corrected starts_at/ends_at for % pre-cutover appointment(s). Old values preserved in s59_false_utc_backfill_audit.', v_fixed_count;
END $$;
