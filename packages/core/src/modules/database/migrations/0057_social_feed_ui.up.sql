-- Social feed UI-02/03 (home feed and post card): an account's public
-- identity gains `verified` (owner decision OA-8, 2026-10-03: verified means
-- X linked). A Mission Control member signed up with X, so its profile always
-- holds an X subject; a new account is verified once its own X subject is
-- set. The X subject itself never leaves the view.
--
-- CREATE OR REPLACE appends the column and keeps the view's grants (SELECT
-- for blast_web and blast_replica, 0056). The view still runs with its owner's
-- rights, so the replica reads this boolean and not the profile behind it.
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
