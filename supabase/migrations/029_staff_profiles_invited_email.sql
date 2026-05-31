-- Store the invited email on staff_profiles so we can resend invitations
-- even when the invitee doesn't have a user account yet.
ALTER TABLE staff_profiles ADD COLUMN IF NOT EXISTS invited_email text;
