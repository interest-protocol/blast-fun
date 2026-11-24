-- Owners can search private following targets, so 0072's public-only GIN is insufficient.
-- Final reads still check live privacy and the current identity; this index exposes no new columns or views.
-- The runner uses a transaction: CREATE INDEX holds SHARE and blocks account writes while building.
CREATE INDEX social_accounts_connection_search_trgm_idx ON social_accounts
  USING gin (lower(COALESCE(callsign, '') || ' ' || COALESCE(display_name, '')) gin_trgm_ops);
