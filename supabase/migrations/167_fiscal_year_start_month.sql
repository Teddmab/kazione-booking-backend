-- Some businesses' fiscal/reporting year doesn't start in January. Default
-- of 1 (January) reproduces exactly today's hardcoded Jan-Dec behavior for
-- every existing business — purely additive, no visible change unless a
-- business actually sets a different start month.
ALTER TABLE business_settings
  ADD COLUMN IF NOT EXISTS fiscal_year_start_month integer NOT NULL DEFAULT 1
    CHECK (fiscal_year_start_month BETWEEN 1 AND 12);
