-- Presale (T-008): the cache of each Privy user's embedded Sui wallet, read by
-- `resolveEmbeddedSuiWallet` (modules/presale/embedded-wallets). One row per
-- Privy DID, written the first time Privy reports the user's embedded Sui
-- wallet (`chain_type` sui, `wallet_client_type` privy, `connector_type`
-- embedded) and never changed or expired: Privy never moves an embedded
-- wallet. A user without one has no row. The web runtime reads and inserts;
-- no role updates or deletes a row. Nothing here is a token, a key or a
-- provider answer: a DID and a public address only.
CREATE TABLE presale_embedded_wallets (
  privy_did TEXT PRIMARY KEY CHECK (privy_did ~ '^did:privy:[A-Za-z0-9_-]{1,128}$'),
  address TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{64}$'),
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE presale_embedded_wallets FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE presale_embedded_wallets TO blast_web;
