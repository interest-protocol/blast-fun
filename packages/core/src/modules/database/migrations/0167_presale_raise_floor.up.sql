CREATE TABLE social_presale_publish_approvals (
  digest text PRIMARY KEY,
  draft_id uuid NOT NULL REFERENCES social_presale_drafts (draft_id) ON DELETE CASCADE,
  draft_version integer NOT NULL,
  creator text NOT NULL
);
CREATE INDEX social_presale_publish_approvals_draft ON social_presale_publish_approvals (draft_id);

REVOKE ALL ON TABLE social_presale_publish_approvals FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE social_presale_publish_approvals TO blast_web;

-- The migration runs while older app instances can still issue publish plans.
-- Set legacy_until only after those writers have drained.
CREATE TABLE social_presale_raise_floor_rollout (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  legacy_until timestamptz
);
INSERT INTO social_presale_raise_floor_rollout DEFAULT VALUES;
REVOKE ALL ON TABLE social_presale_raise_floor_rollout FROM PUBLIC;
GRANT SELECT ON TABLE social_presale_raise_floor_rollout TO blast_web;
