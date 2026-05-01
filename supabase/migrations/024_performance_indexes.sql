-- ─────────────────────────────────────────────────────────────────────────────
-- 024_performance_indexes.sql  –  Missing composite indexes for hot query paths
-- ─────────────────────────────────────────────────────────────────────────────
-- Calendar view: runs on every AppointmentsPage load
CREATE INDEX IF NOT EXISTS idx_appointments_business_start ON appointments(business_id, starts_at);
-- Guest client lookup: runs on every new booking
CREATE INDEX IF NOT EXISTS idx_clients_business_email ON clients(business_id, email);
-- Notification bell: runs on every page that shows notifications
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read, created_at DESC);
