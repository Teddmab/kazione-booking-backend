-- ---------------------------------------------------------------------------
-- 031_drop_duplicate_indexes.sql
--
-- Migration 006 created idx_appointments_business_date on (business_id, starts_at).
-- Migration 024 created idx_appointments_business_start on the same columns.
-- Migration 005 created idx_clients_email on (business_id, email).
-- Migration 024 also created idx_clients_business_email on the same columns.
--
-- Drop the duplicates; keep the better-named versions.
-- ---------------------------------------------------------------------------

-- appointments: keep idx_appointments_business_start (clearer name), drop the original
DROP INDEX IF EXISTS idx_appointments_business_date;

-- clients: keep idx_clients_email (original from 005), drop the duplicate from 024
DROP INDEX IF EXISTS idx_clients_business_email;
