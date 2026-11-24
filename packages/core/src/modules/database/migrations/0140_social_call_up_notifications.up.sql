-- Redesign data gap "Up N% since your call": a notification when a coin the
-- account called (a named presale commit, OA-9) rises past +50%, +100%,
-- +200%, +500% or +1,000% over the sale's entry price, with its own switch
-- (OA-11: every kind has one).
--
-- - `social_notifications.kind` gains `call_up`. Its source key is
--   `call_up:<presale>:<threshold>`, so the key's prefix may now hold an
--   underscore.
-- - `social_notification_preferences.call_moves`: the switch, on by default
--   like the other seven. A constant default rewrites no row.
--
-- The new checks accept every row the old ones did, so each is added NOT VALID
-- and validated after: the validation scans without blocking the worker's
-- inserts or the web's mark-read updates.
ALTER TABLE social_notifications
  DROP CONSTRAINT social_notifications_kind_check,
  ADD CONSTRAINT social_notifications_kind_check
    CHECK (kind IN ('fill', 'follow', 'claim', 'funded', 'soon', 'unlock', 'call_up')) NOT VALID,
  DROP CONSTRAINT social_notifications_source_key_check,
  ADD CONSTRAINT social_notifications_source_key_check
    CHECK (source_key ~ '^[a-z][a-z_]*:[A-Za-z0-9:_.-]{1,200}$') NOT VALID;

ALTER TABLE social_notifications VALIDATE CONSTRAINT social_notifications_kind_check;
ALTER TABLE social_notifications VALIDATE CONSTRAINT social_notifications_source_key_check;

ALTER TABLE social_notification_preferences
  ADD COLUMN call_moves BOOLEAN NOT NULL DEFAULT true;
