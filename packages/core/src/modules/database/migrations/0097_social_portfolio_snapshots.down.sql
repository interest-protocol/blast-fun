-- The snapshots are derived (holdings and prices as they were each day) and
-- cannot be rebuilt once dropped; rolling back loses the trend's history, and
-- when each public portfolio became public.
DROP TABLE IF EXISTS social_portfolio_snapshots;
DROP FUNCTION IF EXISTS social_portfolio_snapshots_check_update();
DROP TRIGGER IF EXISTS social_accounts_portfolio_public_since ON social_accounts;
DROP FUNCTION IF EXISTS social_accounts_set_portfolio_public_since();
ALTER TABLE social_accounts DROP CONSTRAINT IF EXISTS social_accounts_portfolio_public_since;
ALTER TABLE social_accounts DROP COLUMN IF EXISTS portfolio_public_since;
