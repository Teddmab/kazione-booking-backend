-- 157_appointment_notes_reviewed.sql
-- Real, persisted "client prep reviewed" flag, per appointment (not per
-- client — the same client's intake answers/notes are reviewed fresh each
-- visit, since notes/intake can differ appointment to appointment). Null
-- until a staff member explicitly reviews this appointment's client
-- context; stamped via PATCH /appointments?action=mark-notes-reviewed.

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS notes_reviewed_at timestamptz NULL;
