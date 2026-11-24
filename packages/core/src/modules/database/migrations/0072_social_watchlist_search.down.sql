-- Rolls back 0072: the search view and its indexes, then the watchlist (its
-- stars go with it). pg_trgm stays installed (see the up migration).
DROP VIEW IF EXISTS social_account_search;
DROP INDEX IF EXISTS social_profiles_search_trgm_idx;
DROP INDEX IF EXISTS social_accounts_search_trgm_idx;
DROP TABLE IF EXISTS social_watchlist;
