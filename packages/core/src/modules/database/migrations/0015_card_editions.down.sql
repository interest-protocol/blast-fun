ALTER TABLE mission_control_cards
  DROP CONSTRAINT mission_control_cards_record_version_check,
  ADD CONSTRAINT mission_control_cards_record_version_check CHECK (record_version = 1);
