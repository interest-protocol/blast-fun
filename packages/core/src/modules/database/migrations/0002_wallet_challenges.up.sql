CREATE TABLE mission_control_wallet_challenges (
  challenge_id UUID PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('onboarding', 'restore_crew_access')),
  wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{64}$'),
  origin TEXT NOT NULL,
  context_kind TEXT NOT NULL CHECK (context_kind IN ('attempt', 'recovery')),
  context_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  message_hash TEXT NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at = issued_at + INTERVAL '5 minutes'),
  CHECK (
    (action = 'onboarding' AND context_kind = 'attempt') OR
    (action = 'restore_crew_access' AND context_kind = 'recovery')
  ),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);

CREATE INDEX mission_control_wallet_challenges_expiry_idx
  ON mission_control_wallet_challenges (expires_at)
  WHERE consumed_at IS NULL;
