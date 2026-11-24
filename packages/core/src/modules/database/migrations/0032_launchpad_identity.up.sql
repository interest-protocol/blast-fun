-- Launchpad Wallet Proof challenges (modules/launchpad-identity), separate
-- from Mission Control's. A challenge binds an action, origin, canonical Sui
-- address, nonce, issue time and expiry; a protected write consumes it once,
-- in its own transaction. Only hashes of the nonce and signed message are
-- stored: no raw challenge, signature, token or Privy subject has a column.
CREATE TABLE mission_control_launchpad_wallet_challenges (
  challenge_id UUID PRIMARY KEY,
  action TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{64}$'),
  origin TEXT NOT NULL CHECK (char_length(origin) BETWEEN 1 AND 255),
  nonce_hash TEXT NOT NULL UNIQUE CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  message_hash TEXT NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at = issued_at + INTERVAL '5 minutes'),
  CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at))
);

-- Cleanup deletes challenges by expiry (maintenance/repository.ts).
CREATE INDEX mission_control_launchpad_wallet_challenges_expiry_idx
  ON mission_control_launchpad_wallet_challenges (expires_at);

-- Web tables are the web runtime's to read and write, and no one else's (0030).
REVOKE ALL ON TABLE mission_control_launchpad_wallet_challenges FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mission_control_launchpad_wallet_challenges TO blast_web;
