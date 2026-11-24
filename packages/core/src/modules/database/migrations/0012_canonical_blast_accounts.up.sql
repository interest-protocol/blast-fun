CREATE TABLE mission_control_account_identities (
  profile_id UUID NOT NULL REFERENCES mission_control_profiles(profile_id),
  provider TEXT NOT NULL CHECK (provider IN ('x', 'google', 'privy')),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 512),
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mission_control_account_identities_subject_unique
    UNIQUE (provider, provider_subject),
  CONSTRAINT mission_control_account_identities_profile_provider_unique
    UNIQUE (profile_id, provider)
);

CREATE TABLE mission_control_account_wallets (
  wallet_id UUID PRIMARY KEY,
  profile_id UUID NOT NULL REFERENCES mission_control_profiles(profile_id),
  wallet_kind TEXT NOT NULL CHECK (wallet_kind IN ('embedded', 'slush')),
  sui_address TEXT NOT NULL
    CHECK (sui_address ~ '^0x[0-9a-f]{64}$' AND sui_address <> ('0x' || repeat('0', 64))),
  provider_wallet_reference TEXT NOT NULL,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mission_control_account_wallets_address_unique UNIQUE (sui_address),
  CONSTRAINT mission_control_account_wallets_provider_reference_unique
    UNIQUE (provider_wallet_reference),
  CONSTRAINT mission_control_account_wallets_profile_kind_unique
    UNIQUE (profile_id, wallet_kind)
);

CREATE UNIQUE INDEX mission_control_account_wallets_one_primary
  ON mission_control_account_wallets (profile_id)
  WHERE is_primary;

INSERT INTO mission_control_account_identities (
  profile_id, provider, provider_subject, verified_at, created_at
)
SELECT profile_id, 'x', x_subject, created_at, created_at
FROM mission_control_profiles;

ALTER TABLE mission_control_wallet_challenges
  DROP CONSTRAINT mission_control_wallet_challenges_action_check,
  DROP CONSTRAINT mission_control_wallet_challenges_context_kind_check,
  DROP CONSTRAINT mission_control_wallet_challenges_check1;

ALTER TABLE mission_control_wallet_challenges
  ADD CONSTRAINT mission_control_wallet_challenges_action_check
    CHECK (action IN ('onboarding', 'restore_crew_access', 'link_wallet')),
  ADD CONSTRAINT mission_control_wallet_challenges_context_kind_check
    CHECK (context_kind IN ('attempt', 'recovery', 'account')),
  ADD CONSTRAINT mission_control_wallet_challenges_action_context_check
    CHECK (
      (action = 'onboarding' AND context_kind = 'attempt') OR
      (action = 'restore_crew_access' AND context_kind = 'recovery') OR
      (action = 'link_wallet' AND context_kind = 'account')
    );

INSERT INTO mission_control_account_identities (
  profile_id, provider, provider_subject, verified_at, created_at
)
SELECT profile_id, 'privy', privy_did, created_at, created_at
FROM mission_control_profiles;

INSERT INTO mission_control_account_wallets (
  wallet_id, profile_id, wallet_kind, sui_address,
  provider_wallet_reference, is_primary, verified_at, created_at
)
SELECT profile_id,
       profile_id,
       CASE WHEN provider_wallet_reference LIKE 'slush:%'
         THEN 'slush' ELSE 'embedded' END,
       sui_address,
       provider_wallet_reference,
       TRUE,
       disclosure_accepted_at,
       created_at
FROM mission_control_profiles;
