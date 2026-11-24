-- Social feed (T-005): the public identity of every Blast Account, for the
-- item mapper. A member's callsign, display name, avatar and X handle are its
-- Mission Control profile's; a new account holds its own. Never a Privy DID,
-- an X subject or a privacy setting: whether an item shows this identity is
-- the naming rule's decision (read model), not this view's.
--
-- Unlike the other social views this one runs with its owner's rights (no
-- security_invoker), so the replica, which may not read
-- `mission_control_profiles`, reads these five public columns and nothing
-- else of a profile.
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
