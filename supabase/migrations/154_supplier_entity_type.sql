-- 154_supplier_entity_type.sql
-- Lets an owner reclassify a supplier row that isn't actually a vendor
-- (most commonly a tax authority added via "Add Supplier" as a catch-all
-- biller) so it stops being counted/flagged as a real supplier in stats
-- and the "needs attention" heuristics. Read and written entirely through
-- the existing general PATCH ?id= passthrough on /suppliers — no new
-- backend write-path code needed, only this column.

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS entity_type text NOT NULL DEFAULT 'supplier'
    CHECK (entity_type IN ('supplier', 'tax_authority', 'other'));
