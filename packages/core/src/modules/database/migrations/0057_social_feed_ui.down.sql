-- A view cannot drop a column in place: recreate 0056's view and its grants.
DROP VIEW social_account_identities;

CREATE VIEW social_account_identities AS
SELECT
  a.account_id,
  COALESCE(p.callsign, a.callsign) AS callsign,
  CASE WHEN a.profile_id IS NULL THEN a.display_name ELSE p.display_name END AS display_name,
  CASE WHEN a.profile_id IS NULL THEN a.x_avatar_url ELSE COALESCE(p.avatar_reference, p.x_avatar_reference) END AS avatar_url,
  CASE WHEN a.profile_id IS NULL THEN a.x_handle ELSE p.x_handle END AS x_handle
FROM social_accounts a
LEFT JOIN mission_control_profiles p ON p.profile_id = a.profile_id;

REVOKE ALL ON TABLE social_account_identities FROM PUBLIC;
GRANT SELECT ON TABLE social_account_identities TO blast_web, blast_replica;
