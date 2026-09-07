-- 170_tax_return_draft_review.sql
-- Single self-attestation "reviewed" stamp for the VAT prep wizard's Review
-- step. This app has no accountant/collaborator role (member_role is only
-- owner/manager/staff/receptionist), so this is deliberately one reviewer,
-- not a multi-party approval chain.

ALTER TABLE tax_return_drafts
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;
