-- Durable X verification: a request records a job and returns; workers call X
-- later with Blast's app bearer token. Jobs hold no member credentials: the
-- follow check reads the following list of the profile's verified X id.
CREATE TABLE mission_control_x_verification_jobs (
  job_id UUID PRIMARY KEY,
  profile_id UUID NOT NULL REFERENCES mission_control_profiles(profile_id),
  allocation_id UUID NOT NULL REFERENCES mission_control_invitation_allocations(allocation_id),
  kind TEXT NOT NULL CHECK (kind IN ('follow', 'post')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  post_id TEXT CHECK (post_id ~ '^[0-9]{1,25}$'),
  attempts SMALLINT NOT NULL DEFAULT 0,
  max_attempts SMALLINT NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ,
  last_error TEXT CHECK (last_error ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  failure_code TEXT CHECK (failure_code ~ '^[A-Z0-9_]{1,64}$'),
  failure_message TEXT CHECK (char_length(failure_message) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  CONSTRAINT mission_control_x_verification_attempts
    CHECK (attempts BETWEEN 0 AND max_attempts),
  CONSTRAINT mission_control_x_verification_post
    CHECK ((kind = 'post') = (post_id IS NOT NULL)),
  CONSTRAINT mission_control_x_verification_lease
    CHECK ((status = 'running') = (lease_expires_at IS NOT NULL)),
  CONSTRAINT mission_control_x_verification_outcome CHECK (
    (status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL) AND
    (status = 'failed') = (failure_code IS NOT NULL) AND
    (status = 'failed') = (failure_message IS NOT NULL)
  )
);

-- One active job per member and kind; a retry after a terminal job is a new row.
CREATE UNIQUE INDEX mission_control_x_verification_jobs_active
  ON mission_control_x_verification_jobs (profile_id, kind)
  WHERE status IN ('pending', 'running');

CREATE INDEX mission_control_x_verification_jobs_due
  ON mission_control_x_verification_jobs (next_attempt_at)
  WHERE status = 'pending';

CREATE INDEX mission_control_x_verification_jobs_leases
  ON mission_control_x_verification_jobs (lease_expires_at)
  WHERE status = 'running';

CREATE INDEX mission_control_x_verification_jobs_latest
  ON mission_control_x_verification_jobs (profile_id, kind, created_at DESC);

-- Provider-wide pauses shared by every instance, e.g. after an X 429.
CREATE TABLE mission_control_provider_backoff (
  provider TEXT PRIMARY KEY CHECK (provider ~ '^[a-z0-9:_-]{1,32}$'),
  blocked_until TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL CHECK (reason ~ '^[a-z0-9_:-]{1,64}$'),
  updated_at TIMESTAMPTZ NOT NULL
);
