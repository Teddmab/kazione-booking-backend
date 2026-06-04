-- 043_sync_business_country_to_storefront.sql
--
-- 1. Backfills storefronts.country_code from businesses.country where null.
-- 2. Installs a trigger so any future update to businesses.country is
--    automatically mirrored to the linked storefront.

-- ── Backfill ─────────────────────────────────────────────────────────────────
UPDATE storefronts s
   SET country_code = b.country
  FROM businesses b
 WHERE s.business_id = b.id
   AND s.country_code IS NULL
   AND b.country IS NOT NULL;

-- ── Forward-sync trigger ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION sync_storefront_country_from_business()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  UPDATE storefronts
     SET country_code = NEW.country
   WHERE business_id = NEW.id
     AND (country_code IS NULL OR country_code <> NEW.country);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_storefront_country ON businesses;
CREATE TRIGGER trg_sync_storefront_country
  AFTER INSERT OR UPDATE OF country ON businesses
  FOR EACH ROW EXECUTE FUNCTION sync_storefront_country_from_business();
