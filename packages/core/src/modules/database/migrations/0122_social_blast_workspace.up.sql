-- Private account setup on the primary; no replica/public grants or retention job.
-- Account row locking in the owning repository serializes first creation too.
CREATE TABLE IF NOT EXISTS social_blast_workspaces (
  account_id UUID PRIMARY KEY REFERENCES social_accounts (account_id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  workspace JSONB NOT NULL CHECK (jsonb_typeof(workspace) = 'object'),
  revision BIGINT NOT NULL CHECK (revision > 0),
  saved_at_ms BIGINT NOT NULL CHECK (saved_at_ms > 0),
  CHECK (workspace->'schema_version' = to_jsonb(schema_version))
);

-- Keep each writer's accepted high-water acknowledgement indefinitely. Another
-- writer cannot invalidate a successful replay; an older sequence never revives.
CREATE TABLE IF NOT EXISTS social_blast_workspace_writers (
  account_id UUID NOT NULL REFERENCES social_accounts (account_id) ON DELETE CASCADE,
  writer_id TEXT NOT NULL CHECK (length(writer_id) > 0),
  sequence BIGINT NOT NULL CHECK (sequence > 0 AND sequence <= 9007199254740991),
  payload_fingerprint TEXT NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  accepted_revision BIGINT NOT NULL CHECK (accepted_revision > 0),
  saved_at_ms BIGINT NOT NULL CHECK (saved_at_ms > 0),
  PRIMARY KEY (account_id, writer_id)
);

REVOKE ALL ON TABLE social_blast_workspaces, social_blast_workspace_writers FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE social_blast_workspaces, social_blast_workspace_writers TO blast_web;
