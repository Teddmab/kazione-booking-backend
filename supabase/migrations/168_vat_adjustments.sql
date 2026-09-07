-- 168_vat_adjustments.sql
-- Manual VAT adjustment line items for the VAT prep wizard's "Adjustments"
-- tab, which previously only ever showed refunded payments (read-only, no
-- add/edit/delete). amount/tax_amount are signed: positive increases
-- taxable sales, negative decreases it — folded directly into vat-summary's
-- totals alongside payments and expenses.

CREATE TABLE vat_adjustments (
  id          uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period      text NOT NULL, -- YYYY-MM
  description text NOT NULL,
  amount      numeric(10,2) NOT NULL,
  tax_rate    numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount  numeric(10,2) NOT NULL DEFAULT 0,
  reason      text,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_vat_adjustments_business_period ON vat_adjustments(business_id, period);

CREATE TRIGGER trg_vat_adjustments_updated_at
  BEFORE UPDATE ON vat_adjustments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE vat_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY va_select ON vat_adjustments FOR SELECT
  USING (business_id IN (SELECT get_my_business_ids()));

CREATE POLICY va_insert ON vat_adjustments FOR INSERT
  WITH CHECK (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));

CREATE POLICY va_update ON vat_adjustments FOR UPDATE
  USING (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));

CREATE POLICY va_delete ON vat_adjustments FOR DELETE
  USING (get_user_role(business_id) = ANY (ARRAY['owner'::text, 'manager'::text]));
