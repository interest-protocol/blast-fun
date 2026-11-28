ALTER TABLE social_launch_drafts
  DROP CONSTRAINT social_launch_drafts_creator_x,
  DROP COLUMN creator_x_subject,
  DROP COLUMN creator_x_commitment;
