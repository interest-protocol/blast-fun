-- Social feed UI-08 (OA-11, OA-16): signing in with a Sui wallet (Slush).
--
-- A visitor proves control of a Sui address by signing a one-time challenge
-- (Mission Control's wallet challenges, new action `sign_in`). The web app
-- then holds its own wallet session: an opaque token in an HttpOnly cookie,
-- stored here only as its SHA-256. Privy is not involved (OA-16): the social
-- route kit accepts either a Privy access token or this session.
--
-- A wallet caller signs into the account that already holds its address (a
-- Mission Control wallet, a presale embedded wallet, a proven social wallet);
-- otherwise it may create a wallet-only account, keyed by `sui_address`.

ALTER TABLE mission_control_wallet_challenges
  DROP CONSTRAINT mission_control_wallet_challenges_action_check,
  DROP CONSTRAINT mission_control_wallet_challenges_action_context_check;

ALTER TABLE mission_control_wallet_challenges
  ADD CONSTRAINT mission_control_wallet_challenges_action_check
    CHECK (action IN ('onboarding', 'restore_crew_access', 'link_wallet', 'sign_in')),
  ADD CONSTRAINT mission_control_wallet_challenges_action_context_check
    CHECK (
      (action = 'onboarding' AND context_kind = 'attempt') OR
      (action = 'restore_crew_access' AND context_kind = 'recovery') OR
      (action = 'link_wallet' AND context_kind = 'account') OR
      (action = 'sign_in' AND context_kind = 'attempt')
    );

-- A wallet-only account: its Sui address is its sign-in identity, as a Privy
-- DID is a new account's. An account is a member's (profile), or holds a Privy
-- DID, or holds a Sui address. The callsign guard (0054) is unchanged.
ALTER TABLE social_accounts
  ADD COLUMN sui_address TEXT UNIQUE CONSTRAINT social_accounts_sui_address_format CHECK (sui_address ~ '^0x[0-9a-f]{64}$'),
  DROP CONSTRAINT social_accounts_new_account_privy_did,
  ADD CONSTRAINT social_accounts_new_account_identity
    CHECK (profile_id IS NOT NULL OR privy_did IS NOT NULL OR sui_address IS NOT NULL);

-- One row per wallet sign-in. A session lives 30 days at most and ends after
-- 7 idle days, on sign-out (`revoked_at`), or when its row is gone. Each
-- session comes from exactly one consumed challenge.
CREATE TABLE social_wallet_sessions (
  session_id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  wallet_address TEXT NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{64}$'),
  challenge_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT social_wallet_sessions_lifetime CHECK (
    expires_at > created_at AND expires_at <= created_at + INTERVAL '30 days'
  ),
  CONSTRAINT social_wallet_sessions_used CHECK (last_used_at >= created_at),
  CONSTRAINT social_wallet_sessions_revoked CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

-- Expired rows are swept a few at a time when sessions are created.
CREATE INDEX social_wallet_sessions_expiry_idx ON social_wallet_sessions (expires_at);

REVOKE ALL ON TABLE social_wallet_sessions FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE social_wallet_sessions TO blast_web;
