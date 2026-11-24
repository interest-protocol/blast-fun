CREATE TABLE presale_reward_blacklists (
  network TEXT NOT NULL CHECK (network IN ('mainnet','localnet')),
  coin_type TEXT NOT NULL CHECK (coin_type ~ '^0x[0-9a-f]{64}::' AND length(coin_type)<=2048),
  wallets TEXT[] NOT NULL CHECK (cardinality(wallets)<=50 AND array_position(wallets,NULL) IS NULL
    AND array_to_string(wallets,',') ~ '^(0x[0-9a-f]{64}(,0x[0-9a-f]{64})*)?$'),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(network,coin_type)
);
REVOKE ALL ON presale_reward_blacklists FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON presale_reward_blacklists TO blast_web;
GRANT SELECT ON presale_reward_blacklists TO blast_indexer;
