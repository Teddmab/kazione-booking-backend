-- Replaces TaxDeclaration.tsx's "Mark as Filed" state, which today lives
-- only in an unscoped localStorage key (kazione_tax_filings_v1) — filings
-- from one business leak into another business's view in the same browser.
CREATE TABLE tax_filings (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period      text NOT NULL,
  filed_at    timestamptz NOT NULL DEFAULT now(),
  filed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (business_id, period)
);

CREATE INDEX idx_tax_filings_business ON tax_filings(business_id);

ALTER TABLE tax_filings ENABLE ROW LEVEL SECURITY;

CREATE POLICY tf_select ON tax_filings FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY tf_insert ON tax_filings FOR INSERT
  WITH CHECK (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));

CREATE POLICY tf_update ON tax_filings FOR UPDATE
  USING (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));

CREATE POLICY tf_delete ON tax_filings FOR DELETE
  USING (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));
