-- The server pins the X ID and an opaque commitment with the first publish plan.
ALTER TABLE social_launch_drafts
  ADD COLUMN creator_x_subject TEXT CHECK (creator_x_subject ~ '^[1-9][0-9]{0,19}$'),
  ADD COLUMN creator_x_commitment BYTEA CHECK (octet_length(creator_x_commitment) = 32),
  ADD CONSTRAINT social_launch_drafts_creator_x CHECK (
    (creator_x_subject IS NULL AND creator_x_commitment IS NULL) OR
    (creator_x_subject IS NOT NULL AND creator_x_commitment IS NOT NULL AND publication IS NOT NULL)
  );

CREATE UNIQUE INDEX social_launch_drafts_creator_x_commitment_idx
  ON social_launch_drafts (creator_x_commitment) WHERE creator_x_commitment IS NOT NULL;
