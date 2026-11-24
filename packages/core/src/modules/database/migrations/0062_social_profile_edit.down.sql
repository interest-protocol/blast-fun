-- Back to the identity before the edit sheet (0056's expressions with 0057's
-- `verified`; a view's column cannot be dropped by CREATE OR REPLACE), then
-- drop the sheet's columns. A member's display name override is dropped with
-- the view reading it: `display_name` stays (a new account's own name).
CREATE OR REPLACE VIEW social_account_identities AS
SELECT
  a.account_id,
  COALESCE(p.callsign, a.callsign) AS callsign,
  CASE WHEN a.profile_id IS NULL THEN a.display_name ELSE p.display_name END AS display_name,
  CASE WHEN a.profile_id IS NULL THEN a.x_avatar_url ELSE COALESCE(p.avatar_reference, p.x_avatar_reference) END AS avatar_url,
  CASE WHEN a.profile_id IS NULL THEN a.x_handle ELSE p.x_handle END AS x_handle,
  CASE WHEN a.profile_id IS NULL THEN a.x_subject IS NOT NULL ELSE p.x_subject IS NOT NULL END AS verified
FROM social_accounts a
LEFT JOIN mission_control_profiles p ON p.profile_id = a.profile_id;

UPDATE social_accounts SET display_name = NULL WHERE profile_id IS NOT NULL AND display_name IS NOT NULL;

ALTER TABLE social_accounts
  DROP CONSTRAINT IF EXISTS social_accounts_picture_upload,
  DROP COLUMN IF EXISTS profile_updated_at,
  DROP COLUMN IF EXISTS picture_url,
  DROP COLUMN IF EXISTS picture;
