-- Set 'kazione' (brand orange #E84E26) as the default storefront theme.
-- Existing storefronts on the placeholder 'default' (deprecated amber) are
-- migrated to 'kazione' so the real brand color applies everywhere.
ALTER TABLE storefronts ALTER COLUMN theme SET DEFAULT 'kazione';
UPDATE storefronts SET theme = 'kazione' WHERE theme = 'default';
