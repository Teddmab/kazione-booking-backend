-- Migration 109: backfill offer_discount for existing appointments
-- where an appointment_discount offer was applied before migration 108 existed.
-- Gift vouchers are skipped — per-appointment amount can't be derived retroactively.
UPDATE appointments a
SET offer_discount = CASE
    WHEN bo.discount_type = 'percentage'
      THEN ROUND((a.price * bo.discount_value / 100)::numeric, 2)
    ELSE LEAST(bo.discount_value::numeric, a.price::numeric)
  END
FROM offer_redemptions ore
JOIN business_offers bo ON bo.id = ore.offer_id
WHERE a.offer_redemption_id = ore.id
  AND bo.type = 'appointment_discount'
  AND a.offer_discount IS NULL;
