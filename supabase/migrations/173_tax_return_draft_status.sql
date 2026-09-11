-- 173_tax_return_draft_status.sql
-- A manually-set status label for the Obligations tab's "Send for review" /
-- "Accountant review" affordance. There is no real second-party accountant
-- account yet (see 170_tax_return_draft_review.sql's own note on this), so
-- this is a status the owner toggles themselves, not a functioning
-- multi-party approval workflow.

ALTER TABLE tax_return_drafts
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'ready', 'under_review', 'filed'));
