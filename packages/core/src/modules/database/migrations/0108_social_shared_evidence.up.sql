-- Exact current source observations used by daily social portfolio snapshots.
-- This is not a historical reward balance or a source of fabricated zeroes.
CREATE TABLE social_portfolio_balance_observations (
  account_id UUID NOT NULL,
  day DATE NOT NULL,
  source TEXT NOT NULL CHECK (source = 'bounded_fullnode'),
  observed_at_ms BIGINT NOT NULL CHECK (observed_at_ms >= 0),
  sui_atoms NUMERIC(78, 0) NOT NULL CHECK (sui_atoms >= 0),
  usdc_atoms NUMERIC(78, 0) NOT NULL CHECK (usdc_atoms >= 0),
  PRIMARY KEY (account_id, day),
  FOREIGN KEY (account_id, day) REFERENCES social_portfolio_snapshots(account_id, day) ON DELETE CASCADE
);
REVOKE ALL ON social_portfolio_balance_observations FROM PUBLIC, blast_web, blast_social, blast_replica;
GRANT SELECT, INSERT, UPDATE, DELETE ON social_portfolio_balance_observations TO blast_watcher;

-- A source revision makes the final REPEATABLE READ guard reject a mutation
-- committed after its snapshot, even if it committed while table locks waited.
CREATE TABLE social_portfolio_source_revision (
  singleton BOOLEAN PRIMARY KEY CHECK (singleton),
  revision BIGINT NOT NULL CHECK (revision >= 0)
);
INSERT INTO social_portfolio_source_revision VALUES (true, 0);
REVOKE ALL ON social_portfolio_source_revision FROM PUBLIC, blast_web, blast_social, blast_replica, blast_watcher;
CREATE FUNCTION social_bump_portfolio_source_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  UPDATE public.social_portfolio_source_revision SET revision = revision + 1 WHERE singleton;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION social_bump_portfolio_source_revision() FROM PUBLIC, blast_web, blast_social, blast_replica, blast_watcher;
CREATE TRIGGER social_accounts_portfolio_revision AFTER INSERT OR UPDATE OR DELETE ON social_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION social_bump_portfolio_source_revision();
CREATE TRIGGER social_account_wallets_portfolio_revision AFTER INSERT OR UPDATE OR DELETE ON social_account_wallets
  FOR EACH STATEMENT EXECUTE FUNCTION social_bump_portfolio_source_revision();
CREATE TRIGGER social_notification_preferences_portfolio_revision AFTER INSERT OR UPDATE OR DELETE ON social_notification_preferences
  FOR EACH STATEMENT EXECUTE FUNCTION social_bump_portfolio_source_revision();
CREATE TRIGGER mission_control_account_wallets_portfolio_revision AFTER INSERT OR UPDATE OR DELETE ON mission_control_account_wallets
  FOR EACH STATEMENT EXECUTE FUNCTION social_bump_portfolio_source_revision();
CREATE TRIGGER mission_control_account_identities_portfolio_revision AFTER INSERT OR UPDATE OR DELETE ON mission_control_account_identities
  FOR EACH STATEMENT EXECUTE FUNCTION social_bump_portfolio_source_revision();
CREATE TRIGGER presale_embedded_wallets_portfolio_revision AFTER INSERT OR UPDATE OR DELETE ON presale_embedded_wallets
  FOR EACH STATEMENT EXECUTE FUNCTION social_bump_portfolio_source_revision();

-- Freeze fixed canonical owner/privacy sources only during final compare/write.
-- Lock tables first so source writers can finish their revision update; then
-- FOR UPDATE on the revision row raises 40001 if that writer committed after
-- this transaction's snapshot. Normal transaction retry reads a fresh cut.
CREATE FUNCTION social_lock_portfolio_sources() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  LOCK TABLE public.social_accounts, public.social_account_wallets,
    public.social_notification_preferences, public.mission_control_account_wallets,
    public.mission_control_account_identities, public.presale_embedded_wallets IN SHARE MODE;
  PERFORM revision FROM public.social_portfolio_source_revision WHERE singleton FOR UPDATE;
END;
$$;
REVOKE ALL ON FUNCTION social_lock_portfolio_sources() FROM PUBLIC, blast_web, blast_social, blast_replica;
GRANT EXECUTE ON FUNCTION social_lock_portfolio_sources() TO blast_watcher;
