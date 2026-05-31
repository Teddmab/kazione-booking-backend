-- 033_calendar_with_staff_id.sql
-- Adds staff_profile_id to get_business_calendar so the frontend can group
-- appointments by staff for conflict/overlap detection and visual highlighting.
--
-- PostgreSQL does not allow CREATE OR REPLACE FUNCTION when the return type
-- changes, so we DROP first.

DROP FUNCTION IF EXISTS get_business_calendar(uuid, date, date, uuid);

CREATE FUNCTION get_business_calendar(
  p_business_id uuid,
  p_start_date  date,
  p_end_date    date,
  p_staff_id    uuid DEFAULT NULL
)
RETURNS TABLE (
  appointment_id     uuid,
  starts_at          timestamptz,
  ends_at            timestamptz,
  status             appointment_status,
  booking_reference  text,
  client_first_name  text,
  client_last_name   text,
  service_name       text,
  staff_profile_id   uuid,
  staff_display_name text,
  price              numeric,
  booking_source     booking_source,
  is_walk_in         boolean
)
AS $$
BEGIN
  RETURN QUERY
  SELECT a.id               AS appointment_id,
         a.starts_at,
         a.ends_at,
         a.status,
         a.booking_reference,
         c.first_name       AS client_first_name,
         c.last_name        AS client_last_name,
         s.name             AS service_name,
         a.staff_profile_id,
         sp.display_name    AS staff_display_name,
         a.price,
         a.booking_source,
         a.is_walk_in
    FROM appointments a
    LEFT JOIN clients        c  ON c.id  = a.client_id
    LEFT JOIN services       s  ON s.id  = a.service_id
    LEFT JOIN staff_profiles sp ON sp.id = a.staff_profile_id
   WHERE a.business_id = p_business_id
     AND a.starts_at::date >= p_start_date
     AND a.starts_at::date <= p_end_date
     AND (p_staff_id IS NULL OR a.staff_profile_id = p_staff_id)
   ORDER BY a.starts_at;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;
