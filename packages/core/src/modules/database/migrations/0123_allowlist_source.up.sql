ALTER TABLE presale_allowlists ADD COLUMN source JSONB;
COMMENT ON COLUMN presale_allowlists.source IS 'Original CSV row count and optional card-holder inclusion; null for legacy manifests.';
