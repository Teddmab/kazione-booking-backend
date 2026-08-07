-- ─────────────────────────────────────────────────────────────────────────────
-- 089 — Drop stale get_available_slots 4-param overload (S33 bugfix)
--
-- Problem: Migration 086 (dual_staff) added a 5-param overload with
-- p_min_staff int DEFAULT 1 alongside the existing 4-param overload from
-- migration 049. Callers that pass only 4 named params (p_business_id,
-- p_service_id, p_staff_id, p_date) now match BOTH overloads, causing
-- "function get_available_slots is not unique" → create-booking 500 errors.
--
-- Fix: drop the 4-param version. The 5-param version with DEFAULT 1 is
-- fully backwards-compatible — calls without p_min_staff continue to work.
-- ─────────────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS get_available_slots(uuid, uuid, uuid, date);
