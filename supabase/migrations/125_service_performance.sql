-- 125_service_performance.sql
--
-- Powers the /owner/services catalogue redesign's period-scoped metrics
-- (overview "Service value"/"Completed bookings", each row's own figures,
-- and the "Most booked"/"Highest service value" sort options). Nothing
-- currently aggregates appointments by service_id — this mirrors
-- get_staff_performance's shape/spirit (103_financial_integrity.sql),
-- just grouped by service instead of staff.

CREATE OR REPLACE FUNCTION get_service_performance(
  p_business_id  uuid,
  p_start_date   date,
  p_end_date     date
)
RETURNS TABLE (
  service_id     uuid,
  bookings       int,
  service_value  numeric
)
AS $$
BEGIN
  RETURN QUERY
  SELECT a.service_id,
         COUNT(*)::int                AS bookings,
         COALESCE(SUM(a.price), 0)    AS service_value
    FROM appointments a
   WHERE a.business_id = p_business_id
     AND a.starts_at::date BETWEEN p_start_date AND p_end_date
     AND a.status = 'completed'
     AND a.service_id IS NOT NULL
     AND a.deleted_at IS NULL
   GROUP BY a.service_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
