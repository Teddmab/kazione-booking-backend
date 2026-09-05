-- PostgREST cannot auto-detect self-referencing foreign keys for embedding
-- (appointments.cross_business_conflict_appointment_id -> appointments.id) —
-- the FK-hint embed syntax used in 141 silently resolves to the wrong
-- direction (reverse one-to-many, always empty) instead of erroring, since
-- both ends of the relationship are the same table. PostgREST's documented
-- fix is a "computed relationship": a function taking the row and returning
-- `setof appointments rows 1`, called by its bare name in `select=`.
create or replace function cross_business_conflict(appointments)
  returns setof appointments
  rows 1
  language sql
  stable
as $$
  select * from appointments where id = $1.cross_business_conflict_appointment_id
$$;
