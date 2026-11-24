-- Presale (T-010): each signed-in account's explorer and theme
-- (`GET|PUT /api/account/settings`, modules/presale/settings). One row per
-- Privy DID, written by the account's PUT, which replaces both values. An
-- account without a row gets the configured defaults. The web runtime reads,
-- inserts and updates; no role deletes a row. Nothing here is a token or a
-- secret: a DID and two display preferences.
CREATE TABLE presale_account_settings (
  privy_did TEXT PRIMARY KEY CHECK (privy_did ~ '^did:privy:[A-Za-z0-9_-]{1,128}$'),
  explorer TEXT NOT NULL CHECK (explorer IN ('suivision', 'suiscan')),
  theme TEXT NOT NULL CHECK (theme IN ('system', 'dark', 'light')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE presale_account_settings FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE presale_account_settings TO blast_web;
