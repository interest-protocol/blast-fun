-- Durable registration lets wallet linking succeed while infra is unavailable.
CREATE TABLE social_wallet_balance_requests (
    owner TEXT PRIMARY KEY CHECK (owner ~ '^0x[0-9a-f]{64}$'),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX social_wallet_balance_requests_oldest ON social_wallet_balance_requests(requested_at, owner);
GRANT UPDATE (owner) ON social_wallet_balance_requests TO blast_watcher;
GRANT SELECT, DELETE ON social_wallet_balance_requests TO blast_watcher;
CREATE FUNCTION register_linked_wallet_balance() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE address TEXT;
BEGIN
    address := to_jsonb(NEW)->>CASE TG_TABLE_NAME WHEN 'mission_control_account_wallets' THEN 'sui_address' ELSE 'address' END;
    INSERT INTO social_wallet_balance_requests(owner) VALUES (address) ON CONFLICT DO NOTHING;
    RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION register_linked_wallet_balance() FROM PUBLIC;
CREATE TRIGGER register_wallet_balance AFTER INSERT OR UPDATE OF address ON social_account_wallets
FOR EACH ROW EXECUTE FUNCTION register_linked_wallet_balance();
CREATE TRIGGER register_wallet_balance AFTER INSERT OR UPDATE OF sui_address ON mission_control_account_wallets
FOR EACH ROW EXECUTE FUNCTION register_linked_wallet_balance();
CREATE TRIGGER register_wallet_balance AFTER INSERT OR UPDATE OF address ON presale_embedded_wallets
FOR EACH ROW EXECUTE FUNCTION register_linked_wallet_balance();
INSERT INTO social_wallet_balance_requests(owner)
SELECT address FROM social_account_wallets UNION SELECT sui_address FROM mission_control_account_wallets
UNION SELECT address FROM presale_embedded_wallets ON CONFLICT DO NOTHING;
