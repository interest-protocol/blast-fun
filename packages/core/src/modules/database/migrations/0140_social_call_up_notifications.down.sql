ALTER TABLE social_notification_preferences
  DROP COLUMN IF EXISTS call_moves;

DELETE FROM social_notifications WHERE kind = 'call_up';

ALTER TABLE social_notifications
  DROP CONSTRAINT IF EXISTS social_notifications_kind_check,
  ADD CONSTRAINT social_notifications_kind_check
    CHECK (kind IN ('fill', 'follow', 'claim', 'funded', 'soon', 'unlock')),
  DROP CONSTRAINT IF EXISTS social_notifications_source_key_check,
  ADD CONSTRAINT social_notifications_source_key_check
    CHECK (source_key ~ '^[a-z]+:[A-Za-z0-9:_.-]{1,200}$');
