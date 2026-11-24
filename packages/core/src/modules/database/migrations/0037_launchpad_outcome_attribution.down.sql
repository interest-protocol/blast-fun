DROP TABLE IF EXISTS mission_control_launchpad_outcome_commitments;
DROP INDEX IF EXISTS mission_control_launchpad_outcomes_sender_idx;
ALTER TABLE IF EXISTS mission_control_launchpad_outcomes
  DROP CONSTRAINT IF EXISTS mission_control_launchpad_outcomes_link_with_visitor,
  DROP CONSTRAINT IF EXISTS mission_control_launchpad_outcomes_sender_required,
  DROP COLUMN IF EXISTS visitor_link,
  DROP COLUMN IF EXISTS sender_wallet;
