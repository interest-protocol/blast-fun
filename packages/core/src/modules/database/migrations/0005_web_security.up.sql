CREATE TABLE mission_control_oauth_states (
  state_hash TEXT PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash TEXT NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  pkce_verifier_hash TEXT NOT NULL CHECK (pkce_verifier_hash ~ '^[0-9a-f]{64}$'),
  origin TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + INTERVAL '15 minutes'),
  CHECK (consumed_at IS NULL OR consumed_at >= issued_at)
);

CREATE INDEX mission_control_oauth_states_expiry_idx
  ON mission_control_oauth_states (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE mission_control_rate_limit_windows (
  policy_name TEXT NOT NULL,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  subject_hash TEXT NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  window_seconds INTEGER NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (
    policy_name,
    policy_version,
    subject_hash,
    window_seconds,
    window_started_at
  ),
  CHECK (expires_at = window_started_at + make_interval(secs => window_seconds))
);

CREATE INDEX mission_control_rate_limit_windows_expiry_idx
  ON mission_control_rate_limit_windows (expires_at);

CREATE TABLE mission_control_abuse_decision_audit (
  decision_id UUID PRIMARY KEY,
  policy_version INTEGER NOT NULL CHECK (policy_version > 0),
  bucket TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (
    decision IN ('ordinary', 'challenge_required', 'challenge_passed', 'challenge_failed')
  ),
  reason TEXT NOT NULL CHECK (reason IN ('normal_pattern', 'abnormal_failures')),
  occurred_at TIMESTAMPTZ NOT NULL
);

COMMENT ON TABLE mission_control_abuse_decision_audit IS
  'Identifier-free adaptive abuse decisions; never identity or fingerprint data.';
